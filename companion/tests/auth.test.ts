/**
 * Authentication tests. Each case names the attack it refuses, not the function it calls.
 * @module
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { rmSync } from 'node:fs'
import {
  brokerProof,
  createNonce,
  createSecret,
  loadOrCreateCredentials,
  pairingCode,
  pairingCodeMatches,
  proofsMatch,
  roleProof,
} from '../src/auth.ts'
import { ROLE } from '../src/protocol.ts'

const workspaces: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-connector-auth-'))
  workspaces.push(dir)
  return dir
}

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

describe('role-bound proofs', () => {
  const secret = createSecret()
  const nonce = createNonce()

  it('accepts the proof the client is expected to produce', () => {
    const supplied = roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)
    const expected = roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)
    assert.equal(proofsMatch(supplied, expected), true)
  })

  it('refuses a browser proof presented as an agent', () => {
    const captured = roleProof(secret, ROLE.BROWSER, 'client-1', nonce)
    const expectedAsAgent = roleProof(secret, ROLE.AGENT, 'client-1', nonce)
    assert.equal(proofsMatch(captured, expectedAsAgent), false)
  })

  it('refuses an agent proof presented as a browser', () => {
    const captured = roleProof(secret, ROLE.AGENT, 'client-1', nonce)
    const expectedAsBrowser = roleProof(secret, ROLE.BROWSER, 'client-1', nonce)
    assert.equal(proofsMatch(captured, expectedAsBrowser), false)
  })

  it('refuses a proof replayed against a new challenge', () => {
    const captured = roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)
    const freshNonce = createNonce()
    assert.notEqual(freshNonce, nonce)
    assert.equal(proofsMatch(captured, roleProof(secret, ROLE.BROWSER, 'browser-1', freshNonce)), false)
  })

  it('refuses a proof minted for a different client id', () => {
    const captured = roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)
    assert.equal(proofsMatch(captured, roleProof(secret, ROLE.BROWSER, 'browser-2', nonce)), false)
  })

  it('refuses a proof minted under a different secret', () => {
    const captured = roleProof(createSecret(), ROLE.BROWSER, 'browser-1', nonce)
    assert.equal(proofsMatch(captured, roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)), false)
  })

  it('refuses a proof that differs by one character', () => {
    const expected = roleProof(secret, ROLE.BROWSER, 'browser-1', nonce)
    const tampered = `${expected.slice(0, -1)}${expected.endsWith('a') ? 'b' : 'a'}`
    assert.equal(proofsMatch(tampered, expected), false)
  })
})

describe('broker proofs', () => {
  const secret = createSecret()
  const clientNonce = createNonce()

  it('authenticates the broker back to the client', () => {
    const supplied = brokerProof(secret, ROLE.AGENT, 'agent-1', clientNonce)
    assert.equal(proofsMatch(supplied, brokerProof(secret, ROLE.AGENT, 'agent-1', clientNonce)), true)
  })

  it('is not interchangeable with a client proof over the same inputs', () => {
    const client = roleProof(secret, ROLE.AGENT, 'agent-1', clientNonce)
    const broker = brokerProof(secret, ROLE.AGENT, 'agent-1', clientNonce)
    assert.notEqual(client, broker)
    assert.equal(proofsMatch(client, broker), false)
  })

  it('is bound to the granted role', () => {
    const asAgent = brokerProof(secret, ROLE.AGENT, 'client-1', clientNonce)
    const asBrowser = brokerProof(secret, ROLE.BROWSER, 'client-1', clientNonce)
    assert.equal(proofsMatch(asAgent, asBrowser), false)
  })
})

describe('proof comparison', () => {
  it('rejects non-string input rather than throwing', () => {
    assert.equal(proofsMatch(undefined as unknown as string, 'abc'), false)
    assert.equal(proofsMatch('abc', null as unknown as string), false)
  })

  it('rejects a shorter candidate rather than throwing', () => {
    assert.equal(proofsMatch('abc', 'abcd'), false)
  })
})

describe('pairing code', () => {
  it('is stable for one secret and different across secrets', () => {
    const secret = createSecret()
    assert.equal(pairingCode(secret), pairingCode(secret))
    assert.notEqual(pairingCode(secret), pairingCode(createSecret()))
  })

  it('uses only the confusion-free alphabet', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.match(pairingCode(createSecret()), /^[34679ACDEFGHJKMNPQRTUVWXY-]+$/)
    }
  })

  it('is not the secret and does not contain it', () => {
    const secret = createSecret()
    const code = pairingCode(secret)
    assert.notEqual(code.toLowerCase().replace(/-/g, ''), secret)
    assert.equal(secret.includes(code.replace(/-/g, '').toLowerCase()), false)
  })

  it('accepts the code however the user spaced it', () => {
    const secret = createSecret()
    const code = pairingCode(secret)
    assert.equal(pairingCodeMatches(secret, code), true)
    assert.equal(pairingCodeMatches(secret, code.toLowerCase()), true)
    assert.equal(pairingCodeMatches(secret, code.replace(/-/g, ' ')), true)
    assert.equal(pairingCodeMatches(secret, code.replace(/-/g, '')), true)
  })

  it('refuses a code belonging to another secret', () => {
    assert.equal(pairingCodeMatches(createSecret(), pairingCode(createSecret())), false)
  })

  it('refuses empty and malformed input', () => {
    const secret = createSecret()
    assert.equal(pairingCodeMatches(secret, ''), false)
    assert.equal(pairingCodeMatches(secret, undefined as unknown as string), false)
  })
})

describe('credentials file', () => {
  it('creates a usable secret on first run', () => {
    const path = join(workspace(), 'nested', 'credentials.json')
    const created = loadOrCreateCredentials(path)
    assert.match(created.secret, /^[0-9a-f]{64}$/)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).secret, created.secret)
  })

  it('returns the same secret on the next run, so paired browsers stay paired', () => {
    const path = join(workspace(), 'credentials.json')
    assert.equal(loadOrCreateCredentials(path).secret, loadOrCreateCredentials(path).secret)
  })

  it('restricts the secret to the owner on POSIX', { skip: process.platform === 'win32' }, () => {
    const path = join(workspace(), 'credentials.json')
    loadOrCreateCredentials(path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  it('refuses a malformed file instead of silently re-pairing every browser', () => {
    const path = join(workspace(), 'credentials.json')
    writeFileSync(path, '{ not json', 'utf8')
    assert.throws(() => loadOrCreateCredentials(path), /not valid JSON/)
  })

  it('refuses a file whose secret is not a usable secret', () => {
    const path = join(workspace(), 'credentials.json')
    writeFileSync(path, JSON.stringify({ secret: 'short' }), 'utf8')
    assert.throws(() => loadOrCreateCredentials(path), /no usable secret/)
  })
})
