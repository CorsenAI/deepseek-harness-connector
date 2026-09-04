/**
 * Panel state tests.
 *
 * The status band is the only place a user learns why an agent did nothing, so a snapshot resolving
 * to the wrong state is a product failure, not a cosmetic one. Every state in ADR 0008 must be
 * reachable and must win over the states it should outrank.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PANEL_STATES, resolvePanelState } from '../../extension/src/panel-state.js'
import { LOCALES, REFERENCE_LOCALE, dictionary, t } from '../../extension/src/i18n.js'

/** A connected, paired, session-selected, tab-attached snapshot: the fully working case. */
function ready(): Record<string, unknown> {
  return {
    connected: true,
    settings: { brokerUrl: 'ws://127.0.0.1:8781', pairingCode: 'A3KD7FMQXE94RTUV9CTG' },
    paired: { pairedAt: '2026-09-04T00:00:00.000Z' },
    updateNotice: null,
    brokerState: {
      brokerVersion: '0.1.0',
      sessions: [{ profileId: 'web.abc', sessionId: 's1', title: 'Refactor the parser', tabIds: [11] }],
    },
    bindings: [{ profileId: 'web.abc', sessionId: 's1', tabIds: [11], activeTabId: 11 }],
    selectedScope: { profileId: 'web.abc', sessionId: 's1' },
  }
}

/**
 * @param snapshot - a connector snapshot.
 * @returns the resolved state name.
 */
function nameOf(snapshot: Record<string, unknown>): string {
  return (resolvePanelState(snapshot as never) as { name: string }).name
}

describe('panel state', () => {
  it('reports ready when a selected session owns a tab', () => {
    const state = resolvePanelState(ready() as never) as Record<string, unknown>
    assert.equal(state['name'], 'ready')
    assert.equal(state['tone'], 'ok')
    assert.equal(state['showRoute'], true)
    assert.deepEqual(state['values'], { session: 'Refactor the parser', count: 1 })
  })

  it('welcomes a browser that has never paired', () => {
    const snapshot = { ...ready(), paired: null, connected: false, settings: { brokerUrl: 'x', pairingCode: '' } }
    const state = resolvePanelState(snapshot as never) as Record<string, unknown>
    assert.equal(state['name'], 'first-run')
    assert.equal(state['showPairing'], true)
  })

  it('distinguishes a browser that paired before but lost its code', () => {
    const snapshot = { ...ready(), connected: false, settings: { brokerUrl: 'x', pairingCode: '' } }
    assert.equal(nameOf(snapshot), 'unpaired')
  })

  it('reports pairing while a first handshake is outstanding', () => {
    assert.equal(nameOf({ ...ready(), connected: false, paired: null }), 'pairing')
  })

  it('reports the connector unreachable, naming the address', () => {
    const state = resolvePanelState({ ...ready(), connected: false } as never) as Record<string, unknown>
    assert.equal(state['name'], 'disconnected')
    assert.deepEqual(state['values'], { url: 'ws://127.0.0.1:8781' })
  })

  it('reports no sessions when DeepSeek Harness has none live', () => {
    const snapshot = { ...ready(), brokerState: { brokerVersion: '0.1.0', sessions: [] } }
    assert.equal(nameOf(snapshot), 'no-sessions')
  })

  it('asks for a selection when none was made', () => {
    assert.equal(nameOf({ ...ready(), selectedScope: null }), 'no-selection')
  })

  it('asks for a selection when the chosen session has ended', () => {
    const snapshot = { ...ready(), selectedScope: { profileId: 'web.abc', sessionId: 'gone' } }
    assert.equal(nameOf(snapshot), 'no-selection')
  })

  it('says plainly that nothing is shared before a tab is attached', () => {
    const snapshot = { ...ready(), bindings: [] }
    const state = resolvePanelState(snapshot as never) as Record<string, unknown>
    assert.equal(state['name'], 'no-tabs')
    assert.equal(state['showRoute'], true, 'the route card must stay visible so the user can attach one')
    assert.match(t(dictionary('en'), String(state['detailKey'])), /Nothing is shared/)
  })

  it('lets an update requirement outrank every other state', () => {
    // A version mismatch makes the rest moot: sessions listed under an incompatible protocol are
    // not actionable, so showing "ready" would invite the user to try something that cannot work.
    const snapshot = { ...ready(), updateNotice: { required: true } }
    assert.equal(nameOf(snapshot), 'update-required')
  })

  it('is defensive about a snapshot that is missing everything', () => {
    assert.equal(nameOf({} as Record<string, unknown>), 'first-run')
    assert.equal(nameOf(undefined as unknown as Record<string, unknown>), 'first-run')
  })

  it('reaches every declared state', () => {
    const reached = new Set<string>([
      nameOf({ ...ready(), paired: null, connected: false, settings: { brokerUrl: 'x', pairingCode: '' } }),
      nameOf({ ...ready(), connected: false, settings: { brokerUrl: 'x', pairingCode: '' } }),
      nameOf({ ...ready(), connected: false, paired: null }),
      nameOf({ ...ready(), connected: false }),
      nameOf({ ...ready(), brokerState: { brokerVersion: '0.1.0', sessions: [] } }),
      nameOf({ ...ready(), selectedScope: null }),
      nameOf({ ...ready(), bindings: [] }),
      nameOf(ready()),
      nameOf({ ...ready(), updateNotice: { required: true } }),
    ])
    assert.deepEqual([...reached].sort(), [...PANEL_STATES].sort())
  })
})

describe('panel copy', () => {
  it('gives every state a title and a detail in the reference locale', () => {
    const reference = REFERENCE_LOCALE as Record<string, string>
    const snapshots = [
      { ...ready(), paired: null, connected: false, settings: { brokerUrl: 'x', pairingCode: '' } },
      { ...ready(), connected: false, settings: { brokerUrl: 'x', pairingCode: '' } },
      { ...ready(), connected: false, paired: null },
      { ...ready(), connected: false },
      { ...ready(), brokerState: { brokerVersion: '0.1.0', sessions: [] } },
      { ...ready(), selectedScope: null },
      { ...ready(), bindings: [] },
      ready(),
      { ...ready(), updateNotice: { required: true } },
    ]
    for (const snapshot of snapshots) {
      const state = resolvePanelState(snapshot as never) as { titleKey: string, detailKey: string }
      assert.ok(reference[state.titleKey], `${state.titleKey} is missing from the reference locale`)
      assert.ok(reference[state.detailKey], `${state.detailKey} is missing from the reference locale`)
    }
  })

  it('ships every locale with the same keys, so no language falls back silently', () => {
    const referenceKeys = Object.keys(REFERENCE_LOCALE as Record<string, string>).sort()
    for (const [locale, entries] of Object.entries(LOCALES as Record<string, Record<string, string>>)) {
      assert.deepEqual(Object.keys(entries).sort(), referenceKeys, `locale ${locale} does not match the reference keys`)
    }
  })

  it('fills placeholders and leaves unknown ones visible', () => {
    const dict = dictionary('en')
    assert.match(t(dict, 'stateReadyDetail', { session: 'Fix the parser', count: 2 }), /Fix the parser controls 2 tab/)
    assert.match(t(dict, 'stateReadyDetail', {}), /\{session\}/, 'a missing value must be visible, not blank')
  })

  it('falls back to the reference locale for an unknown language', () => {
    assert.equal(dictionary('xx'), REFERENCE_LOCALE)
    assert.equal(dictionary('fr-CA'), (LOCALES as Record<string, unknown>)['fr'], 'a region variant shares its language')
  })

  it('returns the key itself for a message that does not exist', () => {
    assert.equal(t(dictionary('en'), 'noSuchKey'), 'noSuchKey')
  })
})
