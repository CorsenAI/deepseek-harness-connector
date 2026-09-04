/**
 * Role-bound mutual authentication for the loopback broker (ADR 0003).
 *
 * Loopback is not a trust boundary: any local process and any web page in the user's browser can
 * open a connection. Both peers therefore prove knowledge of a shared secret that is never
 * transmitted, the proof is bound to the claimed role so it cannot be replayed as the other role,
 * and each side's nonce makes the other side's proof single-use.
 *
 * Ported from Corsen AI Hermes Connector v0.2.4 (`hermes-plugin/broker.py`, `role_proof` /
 * `broker_proof`): the same proof construction, re-implemented in TypeScript.
 *
 * @module @corsen-ai/dsh-browser-connector/auth
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Role } from './protocol.ts'

/** Bytes of entropy in a nonce. 16 bytes makes accidental reuse impossible in practice. */
const NONCE_BYTES = 16

/** Bytes of entropy in the pairing secret. */
const SECRET_BYTES = 32

/**
 * Groups in the human-entered pairing code. The code is a short display encoding of the secret's
 * first bytes, not the secret itself.
 */
const PAIRING_CODE_GROUPS = 4
const PAIRING_CODE_GROUP_CHARS = 4

/**
 * Characters used in a pairing code. Digits and uppercase letters minus the pairs a user confuses
 * when reading a code aloud or off a screen: `0`/`O`, `1`/`I`/`L`, `8`/`B`, `S`/`5`, `2`/`Z`.
 */
const PAIRING_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY'

/**
 * Generate a fresh single-use nonce.
 * @returns 32 lowercase hex characters.
 */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

/**
 * Generate a fresh pairing secret.
 * @returns 64 lowercase hex characters.
 */
export function createSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex')
}

/**
 * The proof a client presents to the broker.
 *
 * The role is the first field of the signed message, so a proof produced for `browser` cannot be
 * presented as `agent`: the broker recomputes with the role it is being asked to grant, and the
 * comparison fails.
 * @param secret - the shared pairing secret.
 * @param role - the role the client is claiming.
 * @param clientId - the client's stable identifier.
 * @param serverNonce - the nonce from this connection's `challenge` frame.
 * @returns 64 lowercase hex characters.
 */
export function roleProof(secret: string, role: Role, clientId: string, serverNonce: string): string {
  return createHmac('sha256', secret).update(`${role}:${clientId}:${serverNonce}`).digest('hex')
}

/**
 * The proof the broker returns to an authenticated client.
 *
 * It authenticates the broker to the client, so a process that squats on the port after the real
 * broker exits cannot silently accept requests. The `broker:` prefix keeps this message space
 * disjoint from {@link roleProof}, so neither direction's proof is usable as the other's.
 * @param secret - the shared pairing secret.
 * @param role - the role the broker granted.
 * @param clientId - the client's stable identifier.
 * @param clientNonce - the nonce the client sent in its `hello` frame.
 * @returns 64 lowercase hex characters.
 */
export function brokerProof(secret: string, role: Role, clientId: string, clientNonce: string): string {
  return createHmac('sha256', secret).update(`broker:${role}:${clientId}:${clientNonce}`).digest('hex')
}

/**
 * Compare two proofs without leaking their difference through timing.
 *
 * Lengths are compared first because {@link timingSafeEqual} throws on a length mismatch; a
 * different length is not a secret, since every proof this module produces is the same length.
 * @param left - one proof.
 * @param right - the other proof.
 * @returns whether the two are identical.
 */
export function proofsMatch(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Derive the code the user types into the extension once.
 *
 * The code is a truncated HMAC of a fixed label under the secret, rendered in a
 * confusion-free alphabet. It identifies the secret without being the secret: knowing the code does
 * not let a caller compute {@link roleProof} for an arbitrary nonce.
 * @param secret - the pairing secret.
 * @returns a grouped code such as `A3KD-7FMQ-XE94-RTUV`.
 */
export function pairingCode(secret: string): string {
  const digest = createHmac('sha256', secret).update('pairing-code').digest()
  const groups: string[] = []
  let index = 0
  for (let group = 0; group < PAIRING_CODE_GROUPS; group += 1) {
    let chars = ''
    for (let position = 0; position < PAIRING_CODE_GROUP_CHARS; position += 1) {
      chars += PAIRING_ALPHABET[(digest[index] ?? 0) % PAIRING_ALPHABET.length]
      index += 1
    }
    groups.push(chars)
  }
  return groups.join('-')
}

/**
 * Whether a user-entered pairing code matches this secret, ignoring case, spacing, and dashes.
 * @param secret - the pairing secret held by the broker.
 * @param entered - what the user typed.
 * @returns whether the code identifies this secret.
 */
export function pairingCodeMatches(secret: string, entered: string): boolean {
  const normalize = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return proofsMatch(normalize(pairingCode(secret)), normalize(String(entered ?? '')))
}

/** The persisted pairing material and the broker identity it belongs to. */
export interface Credentials {
  /** The shared secret, 64 hex characters. */
  readonly secret: string
  /** When the secret was first created, ISO 8601. */
  readonly createdAt: string
}

/**
 * Load the pairing secret, creating it on first use.
 *
 * The file is written before the permission is narrowed, so on POSIX it exists briefly with the
 * process umask. It is created inside a directory this function also creates with mode `0700`,
 * which closes that window. Windows has no equivalent mode; the file inherits the user profile's
 * ACL, which is already user-scoped.
 * @param path - absolute path to the credentials file.
 * @returns the loaded or newly created credentials.
 * @throws when the file exists but is not readable, or holds a malformed secret.
 */
export function loadOrCreateCredentials(path: string): Credentials {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('credentials file is not an object')
    const record = parsed as Record<string, unknown>
    const secret = record['secret']
    if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
      throw new Error('credentials file holds no usable secret')
    }
    const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date(0).toISOString()
    return { secret, createdAt }
  } catch (cause) {
    // Any unreadable or unusable existing file is a hard failure rather than a silent re-pair:
    // regenerating would break every already-paired browser without telling the user why.
    if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      if (cause instanceof Error && cause.message.startsWith('credentials file')) throw cause
      if ((cause as NodeJS.ErrnoException)?.code !== undefined) throw cause
      throw new Error(`credentials file at ${path} is not valid JSON`, { cause })
    }
  }

  const credentials: Credentials = { secret: createSecret(), createdAt: new Date().toISOString() }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return credentials
}
