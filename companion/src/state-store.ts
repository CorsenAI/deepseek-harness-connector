/**
 * Durable storage for the broker's scope ownership.
 *
 * Ownership is what makes a Chrome restart restore the same session-to-browser mapping instead of
 * orphaning every attachment, so it outlives the broker process.
 *
 * @module @corsen-ai/dsh-browser-connector/state-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { BrokerState, StateStore } from './broker.ts'
import { ID_PATTERN, SCOPE_SEPARATOR } from './protocol.ts'

/** An empty state, used on a first run and whenever the stored file cannot be trusted. */
const EMPTY: BrokerState = { scopeOwners: {} }

/**
 * Validate one stored scope key.
 *
 * A key is a profile and a session joined by the unit separator. Rejecting anything else keeps a
 * hand-edited or partially written file from introducing a scope no session can ever own.
 * @param key - the candidate key.
 * @returns whether it is a well-formed scope key.
 */
function isScopeKey(key: string): boolean {
  const parts = key.split(SCOPE_SEPARATOR)
  return parts.length === 2 && ID_PATTERN.test(parts[0] as string) && ID_PATTERN.test(parts[1] as string)
}

/**
 * A store backed by one JSON file, written atomically.
 *
 * Writes go to a uniquely named staging file and are renamed into place, so two overlapping broker
 * launches cannot leave a half-written state, and a crash mid-write leaves the previous state.
 * @param path - the state file.
 * @param log - where to report a rejected or unreadable file.
 * @returns the store.
 */
export function fileStateStore(path: string, log: (line: string) => void = () => {}): StateStore {
  return {
    load: () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch (cause) {
        // A missing file is the ordinary first run. Anything else is reported and then treated as
        // empty: losing attachments is recoverable by re-attaching, while trusting a corrupt
        // ownership file is not.
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`ignoring unreadable broker state at ${path}: ${(cause as Error).message}`)
        }
        return EMPTY
      }
      if (typeof parsed !== 'object' || parsed === null) {
        log(`ignoring broker state at ${path}: not an object`)
        return EMPTY
      }
      const rawOwners = (parsed as Record<string, unknown>)['scopeOwners']
      if (typeof rawOwners !== 'object' || rawOwners === null) return EMPTY

      const scopeOwners: Record<string, string> = {}
      let rejected = 0
      for (const [key, owner] of Object.entries(rawOwners as Record<string, unknown>)) {
        if (typeof owner === 'string' && ID_PATTERN.test(owner) && isScopeKey(key)) scopeOwners[key] = owner
        else rejected += 1
      }
      if (rejected > 0) log(`dropped ${rejected} malformed ownership entries from ${path}`)
      return { scopeOwners }
    },

    save: (state) => {
      const staging = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(staging, path)
      } catch (cause) {
        log(`failed to persist broker state to ${path}: ${(cause as Error).message}`)
        rmSync(staging, { force: true })
      }
    },
  }
}
