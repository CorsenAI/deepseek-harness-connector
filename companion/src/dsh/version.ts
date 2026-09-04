/**
 * DeepSeek Harness version detection and range enforcement (ADR 0005).
 *
 * DeepSeek Harness states that its public APIs are pre-stable and that every consumer must be
 * updated. The supported range is therefore an explicit, tested declaration rather than an
 * assumption, and a runtime outside it fails at load with a message naming what is supported.
 *
 * @module @corsen-ai/dsh-browser-connector/dsh/version
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

/**
 * The DeepSeek Harness releases this connector version is tested against.
 *
 * `docs/COMPATIBILITY.md` is the authority and records the evidence for each entry. Widening this
 * range requires a passing lane in that table, not a hopeful edit here.
 */
export const SUPPORTED_DSH = {
  /** Lowest tested `@deepseek-ai/dsh-tools` version, inclusive. */
  minimum: '0.1.2-rc.1',
  /** Highest tested version, inclusive. `null` means no tested upper bound yet. */
  maximum: null as string | null,
} as const

/** What the connector could determine about the DeepSeek Harness runtime it is loaded into. */
export interface DshRuntimeVersion {
  /** The resolved `@deepseek-ai/dsh-tools` version, or `null` when it could not be read. */
  readonly toolsVersion: string | null
  /** Whether the resolved version is inside {@link SUPPORTED_DSH}. */
  readonly supported: boolean
  /** Why an unsupported or unknown version was classified that way. */
  readonly reason: string | null
}

/** One parsed semantic version: release numbers plus an optional prerelease tail. */
interface Parsed {
  readonly release: readonly [number, number, number]
  readonly prerelease: readonly (string | number)[]
}

/**
 * Parse a semantic version.
 *
 * Build metadata is ignored because it never affects precedence.
 * @param value - the version string.
 * @returns the parsed version, or `null` when the string is not a semantic version.
 */
function parse(value: string): Parsed | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  const [, major, minor, patch, tail] = match
  const prerelease = (tail ?? '').length === 0
    ? []
    : (tail as string).split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { release: [Number(major), Number(minor), Number(patch)], prerelease }
}

/**
 * Compare two parsed versions by semantic-version precedence.
 *
 * A version with a prerelease tail precedes the same release without one, and prerelease
 * identifiers compare numerically when both are numeric and lexically otherwise.
 * @param left - the first version.
 * @param right - the second version.
 * @returns a negative number, zero, or a positive number.
 */
function compare(left: Parsed, right: Parsed): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.release[index] as number) - (right.release[index] as number)
    if (difference !== 0) return difference
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const a = left.prerelease[index] as string | number
    const b = right.prerelease[index] as string | number
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    if (typeof a === 'number') return -1
    if (typeof b === 'number') return 1
    return a < b ? -1 : 1
  }
  return left.prerelease.length - right.prerelease.length
}

/**
 * Whether a version falls inside the supported range.
 * @param value - the version to test.
 * @returns whether it is supported, and why not when it is not.
 */
export function withinSupportedRange(value: string): { supported: boolean, reason: string | null } {
  const parsed = parse(value)
  if (!parsed) return { supported: false, reason: `${value} is not a semantic version` }
  const minimum = parse(SUPPORTED_DSH.minimum)
  if (minimum && compare(parsed, minimum) < 0) {
    return { supported: false, reason: `DeepSeek Harness ${value} is older than the supported ${SUPPORTED_DSH.minimum}` }
  }
  const maximum = SUPPORTED_DSH.maximum === null ? null : parse(SUPPORTED_DSH.maximum)
  if (maximum && compare(parsed, maximum) > 0) {
    return { supported: false, reason: `DeepSeek Harness ${value} is newer than the supported ${SUPPORTED_DSH.maximum}` }
  }
  return { supported: true, reason: null }
}

/**
 * Read the DeepSeek Harness version this plugin is running inside.
 *
 * The tool registry package is the signal because it is the API this connector actually depends on;
 * a DSH distribution that changed it is the one that can break us, whatever the CLI reports.
 * @param resolveFrom - module URL to resolve from, for tests.
 * @returns what could be determined about the runtime.
 */
export function detectDshVersion(resolveFrom: string = import.meta.url): DshRuntimeVersion {
  let toolsVersion: string | null = null
  try {
    const manifestPath = createRequire(resolveFrom).resolve('@deepseek-ai/dsh-tools/package.json')
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const version = (manifest as Record<string, unknown> | null)?.['version']
    if (typeof version === 'string') toolsVersion = version
  } catch {
    // Module resolution or reading failed. This function reports rather than guesses; the caller
    // decides what an unknown version means, and nothing else can reach this branch.
  }
  if (toolsVersion === null) {
    return { toolsVersion: null, supported: false, reason: 'the DeepSeek Harness tool registry version could not be read' }
  }
  const verdict = withinSupportedRange(toolsVersion)
  return { toolsVersion, supported: verdict.supported, reason: verdict.reason }
}

/**
 * A human-readable line naming the supported range, for load-time failures and the panel.
 * @returns the description.
 */
export function supportedRangeText(): string {
  return SUPPORTED_DSH.maximum === null
    ? `DeepSeek Harness ${SUPPORTED_DSH.minimum} or newer`
    : `DeepSeek Harness ${SUPPORTED_DSH.minimum} to ${SUPPORTED_DSH.maximum}`
}
