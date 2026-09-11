// The extension's copy of the wire protocol.
//
// `companion/src/protocol.ts` is the authoritative definition. This file mirrors it because the
// extension ships as its own Chrome Web Store package and cannot import from the npm package.
// `companion/tests/protocol-parity.test.ts` loads both and fails when any shared value differs, so
// the duplication cannot drift.

/** Wire-compatibility generation. Peers must match exactly (ADR 0004). */
export const PROTOCOL_VERSION = 1;

/** Loopback port the broker owns. */
export const DEFAULT_BROKER_PORT = 8781;

/** The only host the broker may bind. */
export const BROKER_HOST = "127.0.0.1";

/** WebSocket address the extension connects to by default. */
export const DEFAULT_BROKER_URL = `ws://${BROKER_HOST}:${DEFAULT_BROKER_PORT}`;

/** The two authenticated client roles. The role is bound into the proof (ADR 0003). */
export const ROLE = {
  BROWSER: "browser",
  AGENT: "agent",
};

/** Frames the broker sends to a client. */
export const SERVER = {
  CHALLENGE: "challenge",
  PAIRED: "paired",
  DENIED: "denied",
  STATE: "state",
  PING: "ping",
  ACTION: "action",
  BINDING_REVOKED: "binding_revoked",
  ACTION_RESPONSE: "action_response",
};

/** Frames a client sends to the broker. */
export const CLIENT = {
  HELLO: "hello",
  PONG: "pong",
  BINDING_SYNC: "binding_sync",
  BINDING_UPDATE: "binding_update",
  BINDING_REMOVE: "binding_remove",
  ACTION_RESULT: "action_result",
  SESSION_ANNOUNCE: "session_announce",
  SESSION_RETIRE: "session_retire",
  ACTION_REQUEST: "action_request",
};

/** Browser actions a session may request. */
export const ACTION = {
  SNAPSHOT: "snapshot",
  READ_TEXT: "read_text",
  CURRENT_URL: "current_url",
  CLICK: "click",
  TYPE: "type",
  KEY: "key",
  SCROLL: "scroll",
  HOVER: "hover",
  SELECT_OPTION: "select_option",
  DRAG: "drag",
  FIND: "find",
  NAVIGATE: "navigate",
  BACK: "back",
  FORWARD: "forward",
  RELOAD: "reload",
  WAIT: "wait",
  OPEN_TAB: "open_tab",
  LIST_TABS: "list_tabs",
  SWITCH_TAB: "switch_tab",
  CLOSE_TAB: "close_tab",
  SCREENSHOT: "screenshot",
};

/** Every action kind, in a stable order. */
export const ALL_ACTIONS = Object.freeze(Object.values(ACTION));

/** Actions that change which tabs a scope owns. */
export const BINDING_MUTATING_ACTIONS = new Set([
  ACTION.OPEN_TAB,
  ACTION.SWITCH_TAB,
  ACTION.CLOSE_TAB,
]);

/** Typed failure codes. Callers and tests match on the code, never the message. */
export const ERROR = {
  NO_SESSION: "NO_SESSION",
  NO_BINDING: "NO_BINDING",
  NO_BROWSER: "NO_BROWSER",
  BINDING_CHANGED: "BINDING_CHANGED",
  TAB_GONE: "TAB_GONE",
  ACTION_FAILED: "ACTION_FAILED",
  STALE_REF: "STALE_REF",
  RESTRICTED_PAGE: "RESTRICTED_PAGE",
  UNSUPPORTED_ACTION: "UNSUPPORTED_ACTION",
  TIMEOUT: "TIMEOUT",
  INTERRUPTED: "INTERRUPTED",
  CANCELLED: "CANCELLED",
  PROTOCOL_VERSION: "PROTOCOL_VERSION",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  MALFORMED: "MALFORMED",
  TOO_LARGE: "TOO_LARGE",
  INTERNAL: "INTERNAL",
};

/** Hard bounds, enforced before a frame is dispatched. */
export const LIMITS = {
  MAX_FRAME_BYTES: 8 * 1024 * 1024,
  MAX_TEXT_CHARS: 1_000_000,
  MAX_BINDINGS_PER_BROWSER: 256,
  MAX_TABS_PER_BINDING: 64,
  MAX_SESSIONS_PER_AGENT: 512,
  MAX_PENDING_PER_AGENT: 64,
  ACTION_TIMEOUT_MS: 30_000,
  MAX_ID_CHARS: 160,
};

/** Accepted shape for every opaque identifier that crosses the wire. */
export const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,160}$/;

/** Unit separator joining a profile and a session into one scope key. */
export const SCOPE_SEPARATOR = "\u001F";

/**
 * Build the routing key for one scope.
 * @param {string} profileId The DeepSeek Harness profile and home.
 * @param {string} sessionId The calling agent's session id.
 * @returns {string} The registry key.
 */
export function scopeKey(profileId, sessionId) {
  if (!ID_PATTERN.test(profileId)) throw new Error(`invalid profileId: ${JSON.stringify(profileId)}`);
  if (!ID_PATTERN.test(sessionId)) throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`);
  return `${profileId}${SCOPE_SEPARATOR}${sessionId}`;
}

/** Keys used in `chrome.storage.local`. */
export const STORE = {
  /** `{ browserId, browserName }` minted once per installation (ADR 0007). */
  IDENTITY: "identity",
  /** `{ pairedAt }` once the broker has accepted this installation. */
  PAIRING: "pairing",
  /** `{ brokerUrl, pairingCode }` the user can change. */
  SETTINGS: "settings",
  /** scopeKey to binding. */
  BINDINGS: "bindings",
  /** `{ profileId, sessionId }` the panel currently shows. */
  SELECTED_SCOPE: "selectedScope",
  /** `{ required, extensionVersion, brokerVersion }` after a version mismatch. */
  UPDATE_NOTICE: "updateNotice",
};

/** Defaults for a fresh installation. */
export const DEFAULT_SETTINGS = {
  brokerUrl: DEFAULT_BROKER_URL,
  pairingCode: "",
};
