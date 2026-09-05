// The service worker: browser identity, the broker connection, and action dispatch.
//
// MV3 evicts this worker whenever it likes, so nothing here may depend on staying alive. Every
// piece of state is reconstructed from `chrome.storage.local` on each wake, and the broker
// connection is re-established rather than assumed. Treating the worker as disposable is the design
// (ADR 0001), not a workaround.

import {
  applyBinding,
  bindingList,
  detachTab,
  forgetTab,
  lookup,
  normalizeBinding,
  normalizeRegistry,
  removeScope,
  retainLiveTabs,
  sameRegistry,
  setActiveTab,
} from "./bindings.js";
import { IMPLEMENTED_ACTIONS, runPageAction } from "./page-actions.js";
import { redactionConfig } from "./redact.js";
import {
  CLIENT,
  DEFAULT_SETTINGS,
  ERROR,
  ID_PATTERN,
  PROTOCOL_VERSION,
  ROLE,
  SERVER,
  STORE,
} from "./protocol.js";

/** Bounded reconnect schedule. A tight loop against a dead port would drain the user's battery. */
const RECONNECT_MIN_MS = 750;
const RECONNECT_MAX_MS = 20000;

/** How long the worker keeps itself awake while a connection is wanted. */
const KEEPALIVE_ALARM = "corsen-connector-keepalive";
const KEEPALIVE_MINUTES = 0.5;

/** URL schemes Chrome refuses to let an extension script. */
const RESTRICTED_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:", "view-source:"];

/** Hosts that are ordinary web pages but which Chrome still protects. */
const RESTRICTED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

/** The live connection, or null. Never assume it survived the last event. */
let socket = null;
let authenticated = false;
let clientNonce = "";
let attempts = 0;
let reconnectTimer = null;

/**
 * Read one storage key.
 * @param {string} key The key.
 * @param {unknown} fallback What to return when it is absent.
 * @returns {Promise<any>} The stored value. Storage is untyped; every caller validates what it reads.
 */
async function read(key, fallback) {
  const bag = await chrome.storage.local.get(key);
  return bag[key] ?? fallback;
}

/**
 * Write one storage key.
 * @param {string} key The key.
 * @param {unknown} value The value.
 * @returns {Promise<void>} Settlement after the write.
 */
async function write(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * This installation's persistent identity.
 *
 * Minted once and kept forever. It is never derived from the signed-in Google account, the profile
 * directory, or a window title: those are unstable, and two of them are none of this extension's
 * business (ADR 0007).
 * @returns {Promise<{browserId: string, browserName: string}>} The identity.
 */
async function identity() {
  const stored = await read(STORE.IDENTITY, null);
  if (stored && typeof stored.browserId === "string" && ID_PATTERN.test(stored.browserId)) return stored;
  const created = {
    browserId: `browser-${crypto.randomUUID()}`,
    browserName: "Chrome",
  };
  await write(STORE.IDENTITY, created);
  return created;
}

/** @returns {Promise<{brokerUrl: string, pairingCode: string}>} The user's settings. */
async function settings() {
  return { ...DEFAULT_SETTINGS, ...(await read(STORE.SETTINGS, {})) };
}

/** @returns {Promise<object>} The ownership registry, normalised. */
async function registry() {
  return normalizeRegistry(await read(STORE.BINDINGS, {}));
}

/**
 * Persist the registry and tell the broker, but only when ownership actually changed.
 *
 * A validation pass that changed nothing must not write storage or send a frame; otherwise every
 * worker wake would produce traffic and a storage write for no reason.
 * @param {object} next The new registry.
 * @param {object} previous The registry before the change.
 * @returns {Promise<void>} Settlement after any needed write.
 */
async function persist(next, previous) {
  if (sameRegistry(next, previous)) return;
  await write(STORE.BINDINGS, next);
  send({ type: CLIENT.BINDING_SYNC, bindings: bindingList(next) });
  notifyPanel();
}

/**
 * Drop stored bindings whose tabs no longer exist.
 *
 * Chrome reuses tab ids after a restart, so a restored binding is a claim to verify rather than a
 * fact to act on.
 * @returns {Promise<object>} The validated registry.
 */
async function validateAgainstLiveTabs() {
  const stored = await registry();
  const tabs = await chrome.tabs.query({});
  const validated = retainLiveTabs(stored, tabs.map((tab) => tab.id).filter((id) => typeof id === "number"));
  await persist(validated, stored);
  return validated;
}

/**
 * Why a tab cannot be scripted, or null when it can.
 * @param {chrome.tabs.Tab|undefined} tab The tab.
 * @returns {string|null} A reason for the user and the model.
 */
function restrictionReason(tab) {
  if (!tab || typeof tab.id !== "number") return "that tab no longer exists";
  const url = String(tab.url ?? tab.pendingUrl ?? "");
  if (url === "") return "Chrome has not told the connector what this tab is showing yet";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "this tab's address cannot be read";
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) {
    return `Chrome does not allow extensions to act on ${parsed.protocol} pages`;
  }
  if (RESTRICTED_HOSTS.includes(parsed.hostname)) {
    return "Chrome does not allow extensions to act on the Chrome Web Store";
  }
  return null;
}

// ---- broker connection ----------------------------------------------------

/**
 * Send one frame if the socket is open.
 * @param {object} frame The frame.
 */
function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

/**
 * Compute one role-bound proof.
 *
 * The pairing code the user typed is the shared secret, so the extension can prove knowledge of it
 * without the secret ever crossing the wire (ADR 0003).
 * @param {string} secret The normalised pairing code.
 * @param {string} message The message to sign.
 * @returns {Promise<string>} A lowercase hex HMAC-SHA256.
 */
async function hmac(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reduce whatever the user typed to the canonical secret.
 * @param {string} entered The user's input.
 * @returns {string} The normalised secret, or an empty string.
 */
function normalizePairingCode(entered) {
  const normalized = String(entered ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[34679ACDEFGHJKMNPQRTUVWXY]{20}$/.test(normalized) ? normalized : "";
}

/** Open the broker connection, replacing any existing one. */
async function connect() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { try { socket.close(); } catch { /* already closing */ } socket = null; }
  authenticated = false;

  const config = await settings();
  const secret = normalizePairingCode(config.pairingCode);
  if (secret === "") { notifyPanel(); return; }

  let opened;
  try {
    opened = new WebSocket(config.brokerUrl);
  } catch {
    // A malformed broker URL cannot be retried into working; the panel shows the settings state.
    notifyPanel();
    return;
  }
  socket = opened;

  // Listeners are attached before the socket can open. The broker challenges the moment it accepts
  // a connection, so a handler attached later would miss the challenge and never authenticate.
  opened.addEventListener("open", () => { clientNonce = crypto.randomUUID().replace(/-/g, ""); });
  opened.addEventListener("message", (event) => { void onFrame(opened, secret, event.data); });
  opened.addEventListener("error", () => { /* `close` always follows. */ });
  opened.addEventListener("close", () => {
    if (socket !== opened) return;
    socket = null;
    authenticated = false;
    notifyPanel();
    scheduleReconnect();
  });
}

/** Reconnect after a bounded, growing delay. */
function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempts, 5));
  attempts += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
}

/**
 * Handle one frame from the broker.
 * @param {WebSocket} source The socket it arrived on.
 * @param {string} secret The normalised pairing secret.
 * @param {unknown} raw The payload.
 * @returns {Promise<void>} Settlement after handling.
 */
async function onFrame(source, secret, raw) {
  if (socket !== source) return;
  let frame;
  try {
    frame = JSON.parse(String(raw));
  } catch {
    // The broker is the only writer on this socket, so an unparseable frame means a wrong peer.
    source.close();
    return;
  }
  if (typeof frame !== "object" || frame === null) return;

  switch (frame.type) {
    case SERVER.CHALLENGE: return onChallenge(secret, frame);
    case SERVER.PAIRED: return onPaired(secret, frame);
    case SERVER.DENIED: return onDenied(frame);
    case SERVER.ACTION: return onAction(frame);
    case SERVER.BINDING_REVOKED: return onRevoked(frame);
    case SERVER.STATE: return onState(frame);
    case SERVER.PING: { send({ type: CLIENT.PONG, id: frame.id }); return; }
    default: return;
  }
}

/**
 * Answer the broker's challenge.
 * @param {string} secret The normalised pairing secret.
 * @param {object} frame The challenge frame.
 * @returns {Promise<void>} Settlement after the answer is sent.
 */
async function onChallenge(secret, frame) {
  if (typeof frame.nonce !== "string") return;
  if (clientNonce === "") clientNonce = crypto.randomUUID().replace(/-/g, "");
  const me = await identity();
  send({
    type: CLIENT.HELLO,
    role: ROLE.BROWSER,
    id: me.browserId,
    name: me.browserName,
    nonce: clientNonce,
    proof: await hmac(secret, `${ROLE.BROWSER}:${me.browserId}:${frame.nonce}`),
    protocolVersion: PROTOCOL_VERSION,
    connectorVersion: chrome.runtime.getManifest().version,
    capabilities: [...IMPLEMENTED_ACTIONS],
  });
}

/**
 * Verify the broker's answering proof before trusting the connection.
 *
 * Without this, a process that squatted on the port after the real broker exited would receive the
 * user's page content.
 * @param {string} secret The normalised pairing secret.
 * @param {object} frame The paired frame.
 * @returns {Promise<void>} Settlement after the connection is accepted or dropped.
 */
async function onPaired(secret, frame) {
  const me = await identity();
  const expected = await hmac(secret, `broker:${ROLE.BROWSER}:${me.browserId}:${clientNonce}`);
  if (String(frame.proof ?? "") !== expected) {
    await write(STORE.UPDATE_NOTICE, {
      required: true,
      reason: "The local connector did not prove the pairing code. Re-run the installer and pair again.",
    });
    socket?.close();
    return;
  }
  authenticated = true;
  attempts = 0;
  await write(STORE.PAIRING, { pairedAt: new Date().toISOString() });
  await chrome.storage.local.remove(STORE.UPDATE_NOTICE);
  const validated = await validateAgainstLiveTabs();
  send({ type: CLIENT.BINDING_SYNC, bindings: bindingList(validated) });
  notifyPanel();
}

/**
 * Record a refusal so the panel can explain it.
 * @param {object} frame The denied frame.
 * @returns {Promise<void>} Settlement after the notice is stored.
 */
async function onDenied(frame) {
  const code = String(frame.code ?? ERROR.INTERNAL);
  if (code === ERROR.PROTOCOL_VERSION) {
    // Chrome updated this extension while the local package stayed behind, or the reverse. Retrying
    // cannot fix it, so the panel gets an actionable notice instead of a spinner (ADR 0004).
    await write(STORE.UPDATE_NOTICE, {
      required: true,
      reason: String(frame.message ?? "The extension and the local connector speak different protocol versions."),
      extensionVersion: chrome.runtime.getManifest().version,
    });
  }
  notifyPanel();
}

/**
 * Drop a scope another Chrome profile explicitly claimed.
 * @param {object} frame The revocation frame.
 * @returns {Promise<void>} Settlement after the local binding is removed.
 */
async function onRevoked(frame) {
  const scope = { profileId: String(frame.profileId ?? ""), sessionId: String(frame.sessionId ?? "") };
  if (!ID_PATTERN.test(scope.profileId) || !ID_PATTERN.test(scope.sessionId)) return;
  const current = await registry();
  const next = removeScope(current, scope);
  if (!sameRegistry(next, current)) {
    await write(STORE.BINDINGS, next);
    notifyPanel();
  }
}

/**
 * Cache the broker's state projection for the panel.
 * @param {object} frame The state frame.
 * @returns {Promise<void>} Settlement after the cache is written.
 */
async function onState(frame) {
  await write("brokerState", {
    brokerVersion: frame.brokerVersion ?? null,
    sessions: Array.isArray(frame.sessions) ? frame.sessions : [],
    browsers: Array.isArray(frame.browsers) ? frame.browsers : [],
    at: Date.now(),
  });
  notifyPanel();
}

// ---- action dispatch ------------------------------------------------------

/**
 * Perform one routed action in the scope's own tab.
 *
 * The broker has already decided which tab this scope owns, and this checks again against the local
 * registry before touching anything. Two independent checks are the point: the broker's mirror and
 * the extension's authoritative copy must agree, or the action does not happen.
 * @param {object} frame The action frame.
 * @returns {Promise<void>} Settlement after the result is sent.
 */
async function onAction(frame) {
  const id = String(frame.id ?? "");
  const scope = {
    profileId: String(frame.scope?.profileId ?? ""),
    sessionId: String(frame.scope?.sessionId ?? ""),
  };
  const reply = (payload) => send({ type: CLIENT.ACTION_RESULT, id, ...payload });
  const refuse = (code, message) => reply({ ok: false, error: { code, message } });

  if (!ID_PATTERN.test(scope.profileId) || !ID_PATTERN.test(scope.sessionId)) {
    refuse(ERROR.MALFORMED, "the action named no usable session");
    return;
  }

  const binding = lookup(await registry(), scope);
  if (!binding) {
    refuse(ERROR.NO_BINDING, "this browser has no tab attached to that session");
    return;
  }
  const targetTabId = frame.targetTabId;
  if (binding.activeTabId !== targetTabId || !binding.tabIds.includes(targetTabId)) {
    // The broker routed to a tab this browser no longer considers the scope's active tab. Refusing
    // is the whole point: the two copies of ownership disagreed, so nothing may be assumed.
    refuse(ERROR.BINDING_CHANGED, "the attached tab changed before the action started");
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(targetTabId);
  } catch {
    await releaseClosedTab(targetTabId);
    refuse(ERROR.TAB_GONE, "the attached tab no longer exists");
    return;
  }
  const restricted = restrictionReason(tab);
  if (restricted !== null) {
    refuse(ERROR.RESTRICTED_PAGE, restricted);
    return;
  }

  const kind = String(frame.action?.kind ?? "");
  if (!IMPLEMENTED_ACTIONS.includes(kind)) {
    refuse(ERROR.UNSUPPORTED_ACTION, `this extension does not implement ${kind}`);
    return;
  }
  const args = (frame.action?.args && typeof frame.action.args === "object") ? frame.action.args : {};

  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: runPageAction,
      args: [kind, args, redactionConfig()],
      world: "ISOLATED",
    });
  } catch (cause) {
    // Injection failure is reported as a failure. Reporting success here would tell the model an
    // action happened that Chrome refused to perform.
    refuse(ERROR.ACTION_FAILED, `Chrome refused to run the action in that tab: ${String(cause?.message ?? cause)}`);
    return;
  }

  const outcome = injected?.[0]?.result;
  if (!outcome || typeof outcome !== "object") {
    refuse(ERROR.ACTION_FAILED, "the page returned no result");
    return;
  }
  if (outcome.ok === true) reply({ ok: true, data: outcome.data });
  else {
    refuse(
      String(outcome.error?.code ?? ERROR.ACTION_FAILED),
      String(outcome.error?.message ?? "the page could not perform the action"),
    );
  }
}

/**
 * Forget a tab Chrome has closed.
 * @param {number} tabId The tab id.
 * @returns {Promise<void>} Settlement after the registry is updated.
 */
async function releaseClosedTab(tabId) {
  const current = await registry();
  await persist(forgetTab(current, tabId), current);
}

// ---- panel API ------------------------------------------------------------

/** Tell the panel something changed. It may not be open, which is not an error. */
function notifyPanel() {
  chrome.runtime.sendMessage({ type: "connector/changed" }).catch(() => {
    // No panel is listening. This is the ordinary case, not a failure.
  });
}

/**
 * Handle one request from the side panel.
 * @param {object} message The request.
 * @returns {Promise<object>} The reply.
 */
async function onPanelMessage(message) {
  const kind = String(message?.type ?? "");

  if (kind === "connector/state") {
    const me = await identity();
    return {
      ok: true,
      identity: me,
      connected: authenticated,
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: PROTOCOL_VERSION,
      settings: await settings(),
      paired: await read(STORE.PAIRING, null),
      updateNotice: await read(STORE.UPDATE_NOTICE, null),
      brokerState: await read("brokerState", null),
      bindings: bindingList(await registry()),
      selectedScope: await read(STORE.SELECTED_SCOPE, null),
    };
  }

  if (kind === "connector/settings") {
    const next = { ...(await settings()), ...(message.settings ?? {}) };
    await write(STORE.SETTINGS, next);
    await chrome.storage.local.remove(STORE.UPDATE_NOTICE);
    attempts = 0;
    await connect();
    return { ok: true };
  }

  if (kind === "connector/select-scope") {
    const scope = { profileId: String(message.profileId ?? ""), sessionId: String(message.sessionId ?? "") };
    if (!ID_PATTERN.test(scope.profileId) || !ID_PATTERN.test(scope.sessionId)) {
      return { ok: false, error: "that session cannot be selected" };
    }
    await write(STORE.SELECTED_SCOPE, scope);
    notifyPanel();
    return { ok: true };
  }

  if (kind === "connector/attach") {
    const scope = { profileId: String(message.profileId ?? ""), sessionId: String(message.sessionId ?? "") };
    const tabId = Number(message.tabId);
    if (!ID_PATTERN.test(scope.profileId) || !ID_PATTERN.test(scope.sessionId)) {
      return { ok: false, error: "that session cannot be attached to" };
    }
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, error: "that tab no longer exists" };
    }
    const restricted = restrictionReason(tab);
    if (restricted !== null) return { ok: false, error: restricted };

    const current = await registry();
    const binding = normalizeBinding({
      ...scope,
      tabIds: [...new Set([...(lookup(current, scope)?.tabIds ?? []), tabId])],
      activeTabId: tabId,
    });
    const next = applyBinding(current, binding);
    await write(STORE.BINDINGS, next);
    // An explicit attachment is an ownership claim, so it is announced as an update rather than
    // folded into the next full sync: the broker must revoke the previous owner immediately.
    send({ type: CLIENT.BINDING_UPDATE, ...binding, tabIds: [...binding.tabIds] });
    notifyPanel();
    return { ok: true };
  }

  if (kind === "connector/detach") {
    const scope = { profileId: String(message.profileId ?? ""), sessionId: String(message.sessionId ?? "") };
    const current = await registry();
    const next = typeof message.tabId === "number"
      ? detachTab(current, scope, message.tabId)
      : removeScope(current, scope);
    await write(STORE.BINDINGS, next);
    if (lookup(next, scope)) {
      const binding = lookup(next, scope);
      send({ type: CLIENT.BINDING_UPDATE, ...binding, tabIds: [...binding.tabIds] });
    } else {
      send({ type: CLIENT.BINDING_REMOVE, ...scope });
    }
    notifyPanel();
    return { ok: true };
  }

  if (kind === "connector/set-active-tab") {
    const scope = { profileId: String(message.profileId ?? ""), sessionId: String(message.sessionId ?? "") };
    const current = await registry();
    let next;
    try {
      next = setActiveTab(current, scope, Number(message.tabId));
    } catch (cause) {
      return { ok: false, error: String(cause?.message ?? "that tab is not attached to this session") };
    }
    await write(STORE.BINDINGS, next);
    const binding = lookup(next, scope);
    send({ type: CLIENT.BINDING_UPDATE, ...binding, tabIds: [...binding.tabIds] });
    notifyPanel();
    return { ok: true };
  }

  if (kind === "connector/tabs") {
    const tabs = await chrome.tabs.query({});
    return {
      ok: true,
      tabs: tabs
        .filter((tab) => typeof tab.id === "number")
        .map((tab) => ({
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
          active: tab.active === true,
          restricted: restrictionReason(tab) !== null,
        })),
    };
  }

  if (kind === "connector/reconnect") {
    attempts = 0;
    await connect();
    return { ok: true };
  }

  return { ok: false, error: `unknown request ${kind}` };
}

// ---- lifecycle ------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  onPanelMessage(message).then(respond, (cause) => {
    respond({ ok: false, error: String(cause?.message ?? cause) });
  });
  return true; // The reply is asynchronous.
});

chrome.tabs.onRemoved.addListener((tabId) => { void releaseClosedTab(tabId); });

chrome.runtime.onInstalled.addListener(() => { void wake(); });
chrome.runtime.onStartup.addListener(() => { void wake(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  // The worker is evicted on Chrome's schedule, not ours. A periodic alarm is what brings it back
  // so the broker connection is restored without the user opening the panel.
  if (alarm.name === KEEPALIVE_ALARM && !authenticated) void connect();
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab?.windowId === "number") void chrome.sidePanel.open({ windowId: tab.windowId });
});

/** Restore everything this worker needs after an eviction. */
async function wake() {
  await identity();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  await validateAgainstLiveTabs();
  await connect();
}

// A fresh worker starts here, whether Chrome created it for an install, a startup, or an event.
void wake();
