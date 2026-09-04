/**
 * The wire protocol between the Chrome extension, the local broker, and every DeepSeek Harness
 * plugin instance. This module is the single source of truth for frame kinds, limits, and error
 * codes; `extension/src/protocol.js` mirrors it and `tests/protocol-parity.test.mjs` fails when the
 * two drift.
 *
 * Ported from Corsen AI Hermes Connector v0.2.4 (`extension/src/protocol.js`): the message-kind
 * discipline and the role split are Corsen's own design. The version, transport, action set, and
 * error taxonomy are new for DeepSeek Harness.
 *
 * @module @corsen-ai/dsh-browser-connector/protocol
 */

/**
 * Wire-compatibility generation. Bumped on any change a peer could misread. Peers must match
 * exactly; a range would make the check undecidable (ADR 0004).
 */
export const PROTOCOL_VERSION = 1

/** Loopback port the broker owns. Chosen to avoid `dsh web` (3080) and Hermes Connector (8767). */
export const DEFAULT_BROKER_PORT = 8781

/** The only host the broker may bind. Enforced at startup, not merely defaulted. */
export const BROKER_HOST = '127.0.0.1'

/** WebSocket address the extension connects to by default. */
export const DEFAULT_BROKER_URL = `ws://${BROKER_HOST}:${DEFAULT_BROKER_PORT}`

/**
 * The two authenticated client roles. The role is bound into the authentication proof, so a proof
 * captured from one role cannot be replayed as the other (ADR 0003).
 */
export const ROLE = {
  /** A Chrome extension installation. Requires a `chrome-extension://` Origin. */
  BROWSER: 'browser',
  /** A DeepSeek Harness plugin instance. Must present no Origin at all. */
  AGENT: 'agent',
} as const

export type Role = (typeof ROLE)[keyof typeof ROLE]

/** Frames the broker sends to a client. */
export const SERVER = {
  /** First frame on every connection: `{ nonce, protocolVersion, brokerVersion }`. */
  CHALLENGE: 'challenge',
  /** Authentication accepted: `{ proof, brokerVersion, protocolVersion, capabilities }`. */
  PAIRED: 'paired',
  /** Authentication or version check refused: `{ code, message }`. Sent before close. */
  DENIED: 'denied',
  /** Broker state projection for the panel: `{ browsers, agents, bindings }`. */
  STATE: 'state',
  /** Liveness probe: `{ id }`. */
  PING: 'ping',
  /** To a browser: perform one action. `{ id, scope, targetTabId, action }`. */
  ACTION: 'action',
  /** To a browser: another browser explicitly claimed this scope. `{ scope, reason }`. */
  BINDING_REVOKED: 'binding_revoked',
  /** To an agent: the settled outcome of its request. `{ id, ok, data?, error? }`. */
  ACTION_RESPONSE: 'action_response',
} as const

/** Frames a client sends to the broker. */
export const CLIENT = {
  /** Authentication answer: `{ role, id, name, nonce, proof, protocolVersion, connectorVersion, capabilities }`. */
  HELLO: 'hello',
  /** Liveness answer: `{ id }`. */
  PONG: 'pong',
  /** Browser: the complete binding set after a restart. Restoration only, never a claim. */
  BINDING_SYNC: 'binding_sync',
  /** Browser: the user explicitly attached tabs to one scope. Transfers ownership. */
  BINDING_UPDATE: 'binding_update',
  /** Browser: the user detached a scope entirely. */
  BINDING_REMOVE: 'binding_remove',
  /** Browser: the outcome of one dispatched action. `{ id, ok, data?, error? }`. */
  ACTION_RESULT: 'action_result',
  /** Agent: the sessions currently live in this plugin instance. */
  SESSION_ANNOUNCE: 'session_announce',
  /** Agent: one session ended. `{ sessionId }`. */
  SESSION_RETIRE: 'session_retire',
  /** Agent: perform one action for an exact scope. `{ id, profileId, sessionId, action }`. */
  ACTION_REQUEST: 'action_request',
} as const

/**
 * Browser actions a session may request. Kept small and explicit so the Chrome Web Store reviewer
 * and the user both see exactly what the tool can do. A peer that does not implement a kind omits it
 * from its handshake `capabilities`, and the intersection is what the plugin registers as tools.
 */
export const ACTION = {
  /** Structured accessibility snapshot with opaque element refs. `{ maxChars? }`. */
  SNAPSHOT: 'snapshot',
  /** Visible text only, byte-bounded. `{ maxChars? }`. */
  READ_TEXT: 'read_text',
  /** The scoped active tab's current URL, scrubbed of secret parameters. */
  CURRENT_URL: 'current_url',
  /** Click one element by ref. `{ ref }`. */
  CLICK: 'click',
  /** Type into one element by ref. `{ ref, text, replace?, submit? }`. */
  TYPE: 'type',
  /** Press a key, optionally focused on a ref. `{ key, ref? }`. */
  KEY: 'key',
  /** Scroll the viewport or one element. `{ ref?, to?, dy? }`. */
  SCROLL: 'scroll',
  /** Move the pointer over one element to reveal menus and tooltips. `{ ref }`. */
  HOVER: 'hover',
  /** Choose an option in a select. `{ ref, value?, label? }`. */
  SELECT_OPTION: 'select_option',
  /** Drag one element onto another. `{ from, to }`. */
  DRAG: 'drag',
  /** Find visible text and scroll it into view. `{ text }`. */
  FIND: 'find',
  /** Navigate the scoped active tab. `{ url }`. */
  NAVIGATE: 'navigate',
  /** History navigation in the scoped active tab. */
  BACK: 'back',
  FORWARD: 'forward',
  RELOAD: 'reload',
  /** Wait for the page to settle, bounded. `{ ms? }`. */
  WAIT: 'wait',
  /** Open a new tab inside the calling scope. `{ url? }`. */
  OPEN_TAB: 'open_tab',
  /** List only the calling scope's own tabs. */
  LIST_TABS: 'list_tabs',
  /** Make one of the calling scope's tabs active. `{ tabRef }`. */
  SWITCH_TAB: 'switch_tab',
  /** Close one of the calling scope's tabs. `{ tabRef? }`. */
  CLOSE_TAB: 'close_tab',
} as const

export type ActionKind = (typeof ACTION)[keyof typeof ACTION]

/** Every action kind, in a stable order, for capability negotiation and tests. */
export const ALL_ACTIONS: readonly ActionKind[] = Object.freeze(Object.values(ACTION))

/**
 * Actions that change which tabs a scope owns. Their results are authorized differently from page
 * reads, because the binding legitimately changes while they run (ADR 0007).
 */
export const BINDING_MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  ACTION.OPEN_TAB,
  ACTION.SWITCH_TAB,
  ACTION.CLOSE_TAB,
])

/**
 * Typed failure codes. Every rejection carries one; callers and tests match on the code, never on
 * the human-readable message.
 */
export const ERROR = {
  /** The tool call carried no DeepSeek Harness session identity. Fails closed (ADR 0007). */
  NO_SESSION: 'NO_SESSION',
  /** The scope has no attached tab. There is no fallback target. */
  NO_BINDING: 'NO_BINDING',
  /** The browser that owns this scope is not connected. */
  NO_BROWSER: 'NO_BROWSER',
  /** Ownership or the active tab changed while the action was running. */
  BINDING_CHANGED: 'BINDING_CHANGED',
  /** The target tab no longer exists. */
  TAB_GONE: 'TAB_GONE',
  /** The page refused or could not perform the action. */
  ACTION_FAILED: 'ACTION_FAILED',
  /** The element ref came from an older snapshot and no longer identifies an element. */
  STALE_REF: 'STALE_REF',
  /** A Chrome-internal or Web Store page that extensions may not script. */
  RESTRICTED_PAGE: 'RESTRICTED_PAGE',
  /** The peer does not implement this action kind. */
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  /** The action did not settle within its deadline. */
  TIMEOUT: 'TIMEOUT',
  /** Protocol generations differ. Carries both versions and which side is older. */
  PROTOCOL_VERSION: 'PROTOCOL_VERSION',
  /** The handshake proof, role, or origin precondition failed. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** The frame was not valid JSON, was not an object, or failed field validation. */
  MALFORMED: 'MALFORMED',
  /** The frame exceeded its size cap. */
  TOO_LARGE: 'TOO_LARGE',
  /** An internal failure that is not attributable to the caller. */
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR)[keyof typeof ERROR]

/**
 * Hard bounds. Every one is enforced before a frame is dispatched, so a hostile peer cannot make the
 * broker allocate without limit.
 */
export const LIMITS = {
  /** Largest accepted WebSocket frame. Snapshots of large pages are the sizing case. */
  MAX_FRAME_BYTES: 8 * 1024 * 1024,
  /** Largest text payload the browser may return inside a frame. */
  MAX_TEXT_CHARS: 1_000_000,
  /** Distinct scopes one browser may hold. */
  MAX_BINDINGS_PER_BROWSER: 256,
  /** Tabs one scope may own. */
  MAX_TABS_PER_BINDING: 64,
  /** Sessions one agent connection may announce. */
  MAX_SESSIONS_PER_AGENT: 512,
  /** Actions one agent may have in flight. */
  MAX_PENDING_PER_AGENT: 64,
  /** Deadline for one dispatched browser action. */
  ACTION_TIMEOUT_MS: 30_000,
  /** Longest accepted identifier, in characters. */
  MAX_ID_CHARS: 160,
} as const

/**
 * Accepted shape for every opaque identifier that crosses the wire: browser ids, profile ids,
 * session ids, request ids. Deliberately narrow so an identifier can never carry a separator, a
 * path, or a control character into the scope key.
 */
export const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,160}$/

/** Unit separator joining a profile and a session into one scope key. Never valid inside an id. */
export const SCOPE_SEPARATOR = '\u001F'

/**
 * Build the routing key for one scope.
 * @param profileId - the DeepSeek Harness profile and home the plugin instance belongs to.
 * @param sessionId - the calling agent's `SessionId`.
 * @returns the key used by the broker and the extension registries.
 * @throws when either identifier is missing or malformed, so a bad id can never collapse two scopes.
 */
export function scopeKey(profileId: string, sessionId: string): string {
  if (!ID_PATTERN.test(profileId)) throw new Error(`invalid profileId: ${JSON.stringify(profileId)}`)
  if (!ID_PATTERN.test(sessionId)) throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`)
  return `${profileId}${SCOPE_SEPARATOR}${sessionId}`
}

/** One routed scope: an exact DeepSeek Harness profile and session pair. */
export interface Scope {
  readonly profileId: string
  readonly sessionId: string
}

/** A scope's tab ownership inside one browser. `activeTabId` is always a member of `tabIds`. */
export interface Binding extends Scope {
  readonly tabIds: readonly number[]
  readonly activeTabId: number
}

/** A settled action outcome, in the one shape both roles use. */
export type ActionOutcome =
  | { readonly ok: true, readonly data: unknown }
  | { readonly ok: false, readonly error: { readonly code: ErrorCode, readonly message: string } }
