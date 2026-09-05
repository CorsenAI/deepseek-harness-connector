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

/**
 * Shape of the pairing secret.
 *
 * The secret is the code the user types, not a digest of it. It has to be: a Chrome extension
 * cannot read a file, so the only channel from the installer to the extension is the user's
 * keyboard, and both sides need the same value to compute a proof. Five groups of four characters
 * from a 25-character alphabet is about 93 bits — ample for a local secret that additionally
 * requires an extension origin — while staying short enough to type once.
 */
const PAIRING_CODE_GROUPS = 5
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

/** Total characters in a normalised secret. */
const SECRET_CHARS = PAIRING_CODE_GROUPS * PAIRING_CODE_GROUP_CHARS

/** A normalised secret: exactly the confusion-free alphabet, at the expected length. */
const SECRET_PATTERN = new RegExp(`^[${PAIRING_ALPHABET}]{${SECRET_CHARS}}$`)

/**
 * Generate a fresh pairing secret.
 *
 * Drawn by rejection sampling so every character is uniform over the alphabet: taking a random byte
 * modulo 25 would make the first six characters of the alphabet measurably more likely, throwing
 * away entropy for no reason.
 * @returns {@link SECRET_CHARS} characters from the confusion-free alphabet.
 */
export function createSecret(): string {
  const limit = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length
  let secret = ''
  while (secret.length < SECRET_CHARS) {
    for (const byte of randomBytes(SECRET_CHARS)) {
      if (byte >= limit) continue
      secret += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
      if (secret.length === SECRET_CHARS) break
    }
  }
  return secret
}

/**
 * Reduce whatever the user typed to the canonical secret.
 *
 * Case, spaces, and dashes carry no information, so accepting them all removes an entire class of
 * "the code does not work" support question.
 * @param entered - the user's input.
 * @returns the normalised secret, or an empty string when the input cannot be one.
 */
export function normalizePairingCode(entered: string): string {
  const normalized = String(entered ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return SECRET_PATTERN.test(normalized) ? normalized : ''
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
 * Render the secret as the code the installer shows and the user types.
 *
 * Grouping is presentation only; {@link normalizePairingCode} reverses it.
 * @param secret - the pairing secret.
 * @returns the secret in five hyphen-separated groups of four characters. No specimen is written
 * here on purpose: the release scanner refuses any code-shaped literal in a shipped file, and an
 * example it has to make an exception for is an exception a real secret could hide behind.
 */
export function pairingCode(secret: string): string {
  const groups: string[] = []
  for (let index = 0; index < secret.length; index += PAIRING_CODE_GROUP_CHARS) {
    groups.push(secret.slice(index, index + PAIRING_CODE_GROUP_CHARS))
  }
  return groups.join('-')
}

/**
 * Whether what the user typed is this broker's secret.
 *
 * The broker never uses this to admit a client: authentication is the proof, so a wrong code simply
 * produces a proof that does not verify. This exists for the installer's own "did you type it
 * correctly" check, and compares in constant time so it does not become a way to probe the secret.
 * @param secret - the pairing secret held by the broker.
 * @param entered - what the user typed.
 * @returns whether they match.
 */
export function pairingCodeMatches(secret: string, entered: string): boolean {
  const normalized = normalizePairingCode(entered)
  return normalized !== '' && proofsMatch(normalized, secret)
}

/** The persisted pairing material and the broker identity it belongs to. */
export interface Credentials {
  /** The shared secret: the pairing code the user types, normalised. */
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
    if (typeof secret !== 'string' || normalizePairingCode(secret) !== secret) {
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
