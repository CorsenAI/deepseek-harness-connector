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
  normalizePairingCode,
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

describe('pairing secret', () => {
  it('uses only the confusion-free alphabet, at a fixed length', () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      assert.match(createSecret(), /^[34679ACDEFGHJKMNPQRTUVWXY]{20}$/)
    }
  })

  it('never emits a character a user would misread', () => {
    let seen = ''
    for (let attempt = 0; attempt < 500; attempt += 1) seen += createSecret()
    for (const confusable of ['0', 'O', '1', 'I', 'L', '8', 'B', 'S', '5', '2', 'Z']) {
      assert.equal(seen.includes(confusable), false, `${confusable} is easy to misread and must not appear`)
    }
  })

  it('draws every alphabet character, so no entropy is lost to a modulo bias', () => {
    // 2000 secrets of 20 characters: 40 000 draws over 25 symbols, 1600 expected per symbol with a
    // standard deviation of about 39. A reduction of a byte modulo 25 would favour the first six
    // symbols of the alphabet (256 = 10 × 25 + 6: they get 11 bytes each, the others 10), making
    // each of them 1.10× as likely as the rest. The statistic below is the mean count of those six
    // over the mean of the other nineteen: 1.00 ± 0.01 for an unbiased draw, 1.10 under the bias, so
    // a bound at 1.05 is more than five standard deviations from both. (The former bound on the
    // spread between the rarest and the commonest single symbol was crossed by chance about once in
    // fifty runs — on the Windows lane of 2026-11-05 — and would not have caught the 1.10 either.)
    const alphabet = '34679ACDEFGHJKMNPQRTUVWXY'
    const counts = new Map<string, number>()
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      for (const character of createSecret()) counts.set(character, (counts.get(character) ?? 0) + 1)
    }
    assert.equal(counts.size, alphabet.length, 'every alphabet character must be reachable')
    const mean = (symbols: string) => [...symbols].reduce((sum, symbol) => sum + (counts.get(symbol) ?? 0), 0) / symbols.length
    const ratio = mean(alphabet.slice(0, 6)) / mean(alphabet.slice(6))
    assert.ok(Math.abs(ratio - 1) < 0.05, `the first six symbols are ${ratio.toFixed(3)}× as frequent as the rest; a modulo bias would make that 1.10`)
    // And no single symbol is broken: each within 25 % of its expectation, ten standard deviations.
    for (const [symbol, count] of counts) assert.ok(count > 1200 && count < 2000, `${symbol} was drawn ${count} times of 1600 expected`)
  })

  it('does not repeat across generations', () => {
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 500; attempt += 1) seen.add(createSecret())
    assert.equal(seen.size, 500)
  })
})

describe('pairing code', () => {
  it('renders the secret in typeable groups and nothing more', () => {
    const secret = createSecret()
    const code = pairingCode(secret)
    assert.match(code, /^[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}$/)
    assert.equal(code.replace(/-/g, ''), secret)
  })

  it('accepts the code however the user spaced or cased it', () => {
    const secret = createSecret()
    const code = pairingCode(secret)
    assert.equal(pairingCodeMatches(secret, code), true)
    assert.equal(pairingCodeMatches(secret, code.toLowerCase()), true)
    assert.equal(pairingCodeMatches(secret, code.replace(/-/g, ' ')), true)
    assert.equal(pairingCodeMatches(secret, code.replace(/-/g, '')), true)
    assert.equal(pairingCodeMatches(secret, `  ${code}  `), true)
  })

  it('refuses a code belonging to another broker', () => {
    assert.equal(pairingCodeMatches(createSecret(), pairingCode(createSecret())), false)
  })

  it('refuses empty, short, and malformed input', () => {
    const secret = createSecret()
    assert.equal(pairingCodeMatches(secret, ''), false)
    assert.equal(pairingCodeMatches(secret, undefined as unknown as string), false)
    assert.equal(pairingCodeMatches(secret, secret.slice(0, 19)), false)
    assert.equal(pairingCodeMatches(secret, `${secret}X`), false)
  })

  it('normalises only what can be a secret', () => {
    const secret = createSecret()
    assert.equal(normalizePairingCode(pairingCode(secret)), secret)
    assert.equal(normalizePairingCode('too-short'), '')
    // `0`, `O`, and `L` are outside the alphabet, so a code containing them is not a secret.
    assert.equal(normalizePairingCode('0000-0000-0000-0000-0000'), '')
  })
})

describe('credentials file', () => {
  it('creates a usable secret on first run', () => {
    const path = join(workspace(), 'nested', 'credentials.json')
    const created = loadOrCreateCredentials(path)
    assert.match(created.secret, /^[34679ACDEFGHJKMNPQRTUVWXY]{20}$/)
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
    writeFileSync(path, JSON.stringify({ secret: 'not-a-valid-secret' }), 'utf8')
    assert.throws(() => loadOrCreateCredentials(path), /no usable secret/)
  })
})
