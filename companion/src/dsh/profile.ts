/**
 * Which DeepSeek Harness profile and home this plugin instance belongs to (ADR 0007).
 *
 * The scope routing key is `(profileId, sessionId)`. DeepSeek Harness supplies the session half
 * directly as `exec.agent.id`; this module supplies the profile half, and must make two different
 * homes distinguishable so a second DSH installation cannot collide with the first.
 *
 * @module @corsen-ai/dsh-browser-connector/dsh/profile
 */

import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'

/** Where this plugin instance runs, as the connector identifies it. */
export interface ProfileIdentity {
  /** The routing identifier: a readable profile name plus a digest of its Harness home. */
  readonly profileId: string
  /** The profile directory name, for display. */
  readonly profileName: string
  /** The resolved Harness home. */
  readonly home: string
}

/** Directory holding profiles inside a Harness home, per the DeepSeek Harness profile layout. */
const PROFILES_DIR = 'profiles'

/** Profile name assumed when the plugin cannot tell which profile loaded it. */
const UNKNOWN_PROFILE = 'unknown'

/**
 * Resolve the DeepSeek Harness home.
 *
 * `DSH_HOME` may legitimately point at a profile directory rather than the root; in that case the
 * root is its grandparent, matching how DeepSeek Harness itself resolves a single Harness home.
 * @param environment - the environment to read, for tests.
 * @returns the absolute Harness home.
 */
export function resolveDshHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment['DSH_HOME']
  if (typeof configured === 'string' && configured.trim() !== '') {
    const path = configured.trim()
    const parts = path.split(/[\/]+/).filter((part) => part !== '')
    if (parts.length >= 2 && parts[parts.length - 2] === PROFILES_DIR) {
      return path.slice(0, path.length - (parts[parts.length - 2] as string).length - (parts[parts.length - 1] as string).length - 2)
    }
    return path
  }
  return process.platform === 'win32'
    ? join(environment['LOCALAPPDATA'] ?? homedir(), 'dsh')
    : join(homedir(), '.dsh')
}

/**
 * Derive the profile name from the path this module was loaded through.
 *
 * A bundle installed with `dsh plugin --profile <name> add` lives under
 * `<home>/profiles/<name>/node_modules/...`, so the loading path names the profile without any
 * configuration. A bundle resolved from the installation anchor instead has no profile in its path,
 * and the caller supplies one.
 * @param moduleUrl - this module's URL.
 * @returns the profile name, or `null` when the path does not contain one.
 */
export function profileNameFromPath(moduleUrl: string): string | null {
  let path: string
  try {
    path = fileURLToPath(moduleUrl)
  } catch {
    return null // Not a file URL, so it carries no profile directory.
  }
  const parts = path.split(/[\/]+/)
  const index = parts.lastIndexOf(PROFILES_DIR)
  if (index < 0 || index + 1 >= parts.length) return null
  const name = parts[index + 1]
  return name === undefined || name === '' || name === 'node_modules' ? null : name
}

/**
 * A short stable digest of one Harness home.
 *
 * The home is a filesystem path and cannot appear in a routing identifier, which is restricted to a
 * narrow character set so an identifier can never carry a separator into the scope key. The digest
 * keeps two homes distinguishable without exposing either path over the wire or to the panel.
 * @param home - the Harness home.
 * @returns twelve lowercase hex characters.
 */
export function homeDigest(home: string): string {
  let canonical = home
  try {
    canonical = realpathSync(home)
  } catch {
    // The home may not exist yet on a first run; the configured path is then canonical enough,
    // and nothing else can reach this branch.
  }
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return createHash('sha256').update(`${hostname()}${sep}${normalized}`).digest('hex').slice(0, 12)
}

/**
 * Identify the profile this plugin instance belongs to.
 * @param options - an explicit profile name from configuration, the module URL, and the environment.
 * @returns the routing identity for every action this instance sends.
 */
export function resolveProfileIdentity(options: {
  readonly configuredName?: string | undefined
  readonly moduleUrl?: string
  readonly environment?: NodeJS.ProcessEnv
} = {}): ProfileIdentity {
  const home = resolveDshHome(options.environment ?? process.env)
  const configured = options.configuredName?.trim()
  const derived = profileNameFromPath(options.moduleUrl ?? import.meta.url)
  const raw = (configured !== undefined && configured !== '' ? configured : derived) ?? UNKNOWN_PROFILE
  // The routing identifier is restricted to the protocol's identifier alphabet, so a profile
  // directory containing any other character is reduced rather than allowed to break the key.
  const profileName = raw.replace(/[^A-Za-z0-9_.@-]/g, '-').slice(0, 64) || UNKNOWN_PROFILE
  return { profileId: `${profileName}.${homeDigest(home)}`, profileName, home }
}
