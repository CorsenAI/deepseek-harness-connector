/**
 * Frame validation at the wire boundary.
 *
 * Everything arriving on a socket is hostile until proven otherwise: a local web page, an unrelated
 * local process, or a peer of the wrong version can all send frames. Each function below either
 * returns a fully validated value or throws a {@link FrameError} carrying a typed code; nothing
 * partially validated reaches the router.
 *
 * @module @corsen-ai/dsh-browser-connector/frames
 */

import {
  ACTION,
  type ActionKind,
  type ErrorCode,
  ERROR,
  ID_PATTERN,
  LIMITS,
  type Role,
  ROLE,
  type Scope,
} from './protocol.ts'

/** A rejection with a wire-visible code, so callers never match on message text. */
export class FrameError extends Error {
  /** The typed reason this frame was refused. */
  readonly code: ErrorCode

  /**
   * @param code - the typed reason.
   * @param message - human-readable detail for logs and the panel.
   */
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/** Every valid action kind, for constant-time membership checks. */
const ACTION_KINDS: ReadonlySet<string> = new Set(Object.values(ACTION))

/** Every valid role. */
const ROLES: ReadonlySet<string> = new Set(Object.values(ROLE))

/**
 * Parse one raw WebSocket payload into a frame object.
 *
 * The size cap is applied to the encoded bytes before parsing, so an oversized payload never
 * becomes a JavaScript string. A frame must be a plain object with a string `type`; arrays and
 * primitives are refused because they cannot carry a dispatchable kind.
 * @param raw - the received payload.
 * @returns the parsed frame and its `type`.
 * @throws {FrameError} `TOO_LARGE` past the cap, `MALFORMED` for anything unparseable.
 */
export function parseFrame(raw: Buffer | ArrayBuffer | string): { type: string, frame: Record<string, unknown> } {
  const bytes = typeof raw === 'string'
    ? Buffer.byteLength(raw, 'utf8')
    : raw instanceof ArrayBuffer ? raw.byteLength : raw.length
  if (bytes > LIMITS.MAX_FRAME_BYTES) {
    throw new FrameError(ERROR.TOO_LARGE, `frame of ${bytes} bytes exceeds the ${LIMITS.MAX_FRAME_BYTES} byte cap`)
  }

  const text = typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new FrameError(ERROR.MALFORMED, `frame is not valid JSON: ${(cause as Error)?.message ?? 'unparseable'}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FrameError(ERROR.MALFORMED, 'frame is not a JSON object')
  }
  const frame = parsed as Record<string, unknown>
  const type = frame['type']
  if (typeof type !== 'string' || type.length === 0 || type.length > 64) {
    throw new FrameError(ERROR.MALFORMED, 'frame carries no usable type')
  }
  return { type, frame }
}

/**
 * Validate one opaque identifier.
 * @param value - the candidate.
 * @param field - the field name, for the error message.
 * @returns the identifier.
 * @throws {FrameError} `MALFORMED` when it is absent or does not match {@link ID_PATTERN}.
 */
export function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new FrameError(ERROR.MALFORMED, `${field} is missing or malformed`)
  }
  return value
}

/**
 * Validate an optional short display string, such as a browser or session name.
 *
 * Control characters are stripped rather than rejected: a name is presentation-only, and a session
 * title the user chose should not make a whole frame fail.
 * @param value - the candidate.
 * @param fallback - what to use when absent.
 * @param maxChars - the cap.
 * @returns a safe display string.
 */
export function displayText(value: unknown, fallback: string, maxChars = 120): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim()
  return cleaned.length === 0 ? fallback : cleaned.slice(0, maxChars)
}

/**
 * Validate a claimed role.
 * @param value - the candidate.
 * @returns the role.
 * @throws {FrameError} `UNAUTHENTICATED` for an unknown role, since an unknown role can be granted
 * no privilege and must not be reported as a mere format problem.
 */
export function requireRole(value: unknown): Role {
  if (typeof value !== 'string' || !ROLES.has(value)) {
    throw new FrameError(ERROR.UNAUTHENTICATED, 'unknown client role')
  }
  return value as Role
}

/**
 * Validate the scope fields carried by a routed frame.
 * @param frame - the frame.
 * @returns the exact profile and session pair.
 * @throws {FrameError} `MALFORMED` when either identifier is absent or malformed.
 */
export function requireScope(frame: Record<string, unknown>): Scope {
  return {
    profileId: requireId(frame['profileId'], 'profileId'),
    sessionId: requireId(frame['sessionId'], 'sessionId'),
  }
}

/**
 * Validate a tab id.
 * @param value - the candidate.
 * @param field - the field name, for the error message.
 * @returns the tab id.
 * @throws {FrameError} `MALFORMED` when it is not a non-negative safe integer.
 */
export function requireTabId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new FrameError(ERROR.MALFORMED, `${field} is not a tab id`)
  }
  return value as number
}

/** One validated action request: the kind plus its untrusted, browser-validated arguments. */
export interface ActionRequest {
  readonly kind: ActionKind
  readonly args: Record<string, unknown>
}

/**
 * Validate the `action` member of a request frame.
 *
 * Only the kind is checked here. Per-kind argument validation belongs in the page, next to the code
 * that uses each argument, so this boundary cannot drift out of step with the actions themselves.
 * @param value - the candidate action.
 * @returns the validated kind and its arguments.
 * @throws {FrameError} `MALFORMED` for a missing action, `UNSUPPORTED_ACTION` for an unknown kind.
 */
export function requireAction(value: unknown): ActionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FrameError(ERROR.MALFORMED, 'action is missing')
  }
  const record = value as Record<string, unknown>
  const kind = record['kind']
  if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) {
    throw new FrameError(ERROR.UNSUPPORTED_ACTION, `unknown action kind ${JSON.stringify(kind)}`)
  }
  const args = record['args']
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new FrameError(ERROR.MALFORMED, 'action args must be an object')
  }
  return { kind: kind as ActionKind, args: (args as Record<string, unknown>) ?? {} }
}

/**
 * Validate a declared capability list against the known action kinds.
 *
 * Unknown entries are dropped rather than refused, so a newer peer advertising an action this
 * version has never heard of still connects; the intersection simply omits it.
 * @param value - the candidate list.
 * @returns the recognised kinds, in the protocol's stable order.
 */
export function acceptedCapabilities(value: unknown): ActionKind[] {
  if (!Array.isArray(value)) return []
  const declared = new Set(value.filter((entry): entry is string => typeof entry === 'string'))
  return Object.values(ACTION).filter((kind) => declared.has(kind))
}
