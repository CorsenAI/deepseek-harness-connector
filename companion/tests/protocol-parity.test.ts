/**
 * Protocol parity between the companion and the extension.
 *
 * The extension ships as its own Chrome Web Store package and cannot import the npm package, so the
 * protocol exists twice. Duplication is only safe while something proves the two copies agree: a
 * silent divergence here would be a peer that talks past its counterpart, which the version
 * handshake cannot catch because both would still claim protocol 1.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as companion from '../src/protocol.ts'
import * as extension from '../../extension/src/protocol.js'

/** Values that must be identical in both copies. */
const SHARED_CONSTANTS = [
  'PROTOCOL_VERSION',
  'DEFAULT_BROKER_PORT',
  'BROKER_HOST',
  'DEFAULT_BROKER_URL',
  'SCOPE_SEPARATOR',
] as const

/** Objects whose keys and values must match exactly. */
const SHARED_MAPS = ['ROLE', 'SERVER', 'CLIENT', 'ACTION', 'ERROR', 'LIMITS'] as const

const left = companion as unknown as Record<string, unknown>
const right = extension as unknown as Record<string, unknown>

describe('protocol parity', () => {
  for (const key of SHARED_CONSTANTS) {
    it(`agrees on ${key}`, () => {
      assert.equal(right[key], left[key], `${key} differs between the companion and the extension`)
    })
  }

  for (const key of SHARED_MAPS) {
    it(`agrees on every ${key} member`, () => {
      assert.deepEqual(right[key], left[key], `${key} differs between the companion and the extension`)
    })
  }

  it('agrees on the identifier pattern', () => {
    assert.equal(String(right['ID_PATTERN']), String(left['ID_PATTERN']))
  })

  it('agrees on the action list and its order', () => {
    assert.deepEqual(right['ALL_ACTIONS'], left['ALL_ACTIONS'])
  })

  it('agrees on which actions change tab ownership', () => {
    assert.deepEqual(
      [...(right['BINDING_MUTATING_ACTIONS'] as Set<string>)].sort(),
      [...(left['BINDING_MUTATING_ACTIONS'] as Set<string>)].sort(),
    )
  })

  it('builds the same scope key from both copies', () => {
    const buildLeft = left['scopeKey'] as (a: string, b: string) => string
    const buildRight = right['scopeKey'] as (a: string, b: string) => string
    assert.equal(buildRight('web.abc123', 'session-1'), buildLeft('web.abc123', 'session-1'))
  })

  it('rejects the same malformed identifiers in both copies', () => {
    const buildRight = right['scopeKey'] as (a: string, b: string) => string
    assert.throws(() => buildRight('web abc', 'session-1'), /invalid profileId/)
    assert.throws(() => buildRight('web', ''), /invalid sessionId/)
    // The separator must never be admissible inside an identifier, or two scopes could collide.
    assert.throws(() => buildRight(`web${left['SCOPE_SEPARATOR'] as string}x`, 'session-1'), /invalid profileId/)
  })

  it('exports no action kind the other copy lacks', () => {
    const companionActions = new Set(Object.values(left['ACTION'] as Record<string, string>))
    const extensionActions = new Set(Object.values(right['ACTION'] as Record<string, string>))
    assert.deepEqual([...extensionActions].sort(), [...companionActions].sort())
  })
})
