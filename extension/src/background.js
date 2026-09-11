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
  EMPTY,
  forgetTab,
  lookup,
  normalizeBinding,
  normalizeRegistry,
  removeScope,
  retainLiveTabs,
  sameRegistry,
  setActiveTab,
} from "./bindings.js";
import { IMPLEMENTED_ACTIONS, TAB_ACTIONS, runPageAction } from "./page-actions.js";
import { redactionConfig, scrubUrl } from "./redact.js";
import {
  ACTION,
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
export function restrictionReason(tab) {
  if (!tab || typeof tab.id !== "number") return "that tab no longer exists";
  const url = String(tab.url ?? tab.pendingUrl ?? "");
  // No address means Chrome withheld it, which it does for pages the extension may not touch. An
  // unknown address is treated as restricted, never as safe.
  if (url === "") return "Chrome does not expose this tab's address to the connector, so it is treated as restricted";
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

  const kind = String(frame.action?.kind ?? "");
  if (!IMPLEMENTED_ACTIONS.includes(kind)) {
    refuse(ERROR.UNSUPPORTED_ACTION, `this extension does not implement ${kind}`);
    return;
  }
  const args = (frame.action?.args && typeof frame.action.args === "object") ? frame.action.args : {};

  // Tab-level actions run here with chrome.tabs and never inject, so they work on a tab whose page
  // cannot be scripted — navigating away from a chrome:// page is the point of navigate.
  if (TAB_ACTIONS.includes(kind)) {
    try {
      reply(await performTabAction(kind, args, scope, binding, targetTabId));
    } catch (cause) {
      refuse(ERROR.ACTION_FAILED, String(cause?.message ?? cause));
    }
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

  const inject = () => chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: runPageAction,
    args: [kind, args, redactionConfig()],
    world: "ISOLATED",
  });

  // The document an action was injected into can be replaced while the action runs — by the
  // action itself (a link, a submit, an Enter) or by the page. Chrome then either rejects the
  // injection or resolves it with no result, and neither is a refusal Chrome made. What actually
  // happened is a navigation, and it is reported as one: an action that navigates on purpose is
  // reported performed, with the new address once the page has loaded; a read or a wait is asked
  // again of the page that arrived, since that is the page the model will act on; anything else is
  // told where the page went and that its own outcome is unknown.
  const navigatedAway = async (documentWentAway) => {
    const after = await chrome.tabs.get(targetTabId).catch(() => null);
    if (after === null) return "gone";
    // A refusal Chrome states for another reason — no access to this host, a page it protects —
    // is not a navigation even if the page happens to be loading something at that moment.
    if (!documentWentAway) return null;
    const navigated = await navigationCausedBy(tab, after, targetTabId);
    if (navigated === null) return null;
    if (NAVIGATING_ACTIONS.includes(kind)) {
      reply({ ok: true, data: { ...navigatedSubject(kind, args), navigated: true, ...navigated } });
      return "answered";
    }
    if (!REREADABLE_ACTIONS.includes(kind)) {
      refuse(ERROR.ACTION_FAILED, `the page navigated away while the action was running and is now at ${navigated.url}; `
        + "the action's outcome is unknown, take a fresh snapshot");
      return "answered";
    }
    try {
      const again = await inject();
      const outcome = again?.[0]?.result;
      if (!outcome || typeof outcome !== "object") {
        refuse(ERROR.ACTION_FAILED, `the page navigated to ${navigated.url} while the action was running and returned no result afterwards`);
      } else if (outcome.ok === true) {
        reply({ ok: true, data: { ...outcome.data, navigated: true } });
      } else {
        refuse(String(outcome.error?.code ?? ERROR.ACTION_FAILED), String(outcome.error?.message ?? "the page could not perform the action"));
      }
    } catch (again) {
      refuse(ERROR.ACTION_FAILED, `the page navigated to ${navigated.url} while the action was running, and could not be read `
        + `afterwards: ${String(again?.message ?? again)}`);
    }
    return "answered";
  };

  let injected;
  // A tab closed while its script runs does not always fail the injection promptly: Chrome can
  // leave executeScript pending for seconds on a tab that is being torn down. The removal event
  // is the authoritative, immediate signal, so the action settles on whichever comes first.
  const removal = watchTabRemoval(targetTabId);
  try {
    injected = await Promise.race([inject(), removal.removed]);
  } catch (cause) {
    // Injection failure is reported as a failure. Reporting success here would tell the model an
    // action happened that Chrome refused to perform. A tab that vanished while the action ran is
    // the common cause; it is reported as such BEFORE the binding is cleaned, so the model learns
    // the real reason rather than a later "binding changed".
    // Chrome names the reason: a document torn down under the script reads "Frame with ID … was
    // removed"; a page it will not let the extension into reads "Cannot access …".
    const message = String(cause?.message ?? cause);
    const moved = await navigatedAway(/frame|removed|detached|navigat/i.test(message));
    if (moved === "gone") {
      refuse(ERROR.TAB_GONE, "the attached tab was closed while the action was running");
      await releaseClosedTab(targetTabId);
    } else if (moved === null) {
      refuse(ERROR.ACTION_FAILED, `Chrome refused to run the action in that tab: ${message}`);
    }
    return;
  } finally {
    removal.dispose();
  }

  const outcome = injected?.[0]?.result;
  if (!outcome || typeof outcome !== "object") {
    // Chrome resolves an injection with no result when the document went away mid-script.
    const moved = await navigatedAway(true);
    if (moved === "gone") {
      refuse(ERROR.TAB_GONE, "the attached tab was closed while the action was running");
      await releaseClosedTab(targetTabId);
    } else if (moved === null) {
      refuse(ERROR.ACTION_FAILED, "the page returned no result");
    }
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

/** Actions that navigate on purpose: a click on a link, a submitted form, an Enter. */
const NAVIGATING_ACTIONS = [ACTION.CLICK, ACTION.TYPE, ACTION.KEY];

/**
 * Actions that only read or wait, and so can be asked again of the page that replaced the one
 * they were injected into. A ref-addressed read on the new page fails as stale, which is honest.
 */
const REREADABLE_ACTIONS = [ACTION.SNAPSHOT, ACTION.READ_TEXT, ACTION.CURRENT_URL, ACTION.FIND, ACTION.WAIT, ACTION.SCROLL, ACTION.HOVER];

/**
 * Whether a tab left the document an action was injected into, and where it went.
 *
 * Compared on the address Chrome reports before and after, or on a load in progress: a document
 * replaced by a same-address reload is not a navigation the model needs told about, and a tab
 * merely still loading its old page is not one either.
 * @param {chrome.tabs.Tab} before The tab as read just before the injection.
 * @param {chrome.tabs.Tab} after The tab as read after the injection failed.
 * @param {number} tabId The tab id.
 * @returns {Promise<{url: string, title: string, loaded: string}|null>} The new page once loaded,
 * or null when the tab did not navigate.
 */
async function navigationCausedBy(before, after, tabId) {
  const wasAt = String(before.url ?? "");
  const nowAt = String(after.pendingUrl ?? after.url ?? "");
  const loading = after.status === "loading" && typeof after.pendingUrl === "string";
  if (nowAt === wasAt && !loading) return null;
  await waitForTabComplete(tabId, nowAt);
  const landed = await chrome.tabs.get(tabId).catch(() => after);
  return {
    url: scrubUrl(String(landed.url ?? nowAt)),
    title: String(landed.title ?? "").slice(0, MAX_TAB_TITLE_CHARS),
    loaded: landed.status === "complete" ? "complete" : "loading",
  };
}

/**
 * The required subject field of an action whose page navigated before it could answer.
 *
 * The page module names what it acted on; after a navigation there is no page to ask, so the
 * model's own reference or key stands in. It is what the model asked for, which it already knows.
 * @param {string} kind The action kind.
 * @param {Record<string, unknown>} args The action arguments.
 * @returns {Record<string, string>} The subject field for that kind.
 */
function navigatedSubject(kind, args) {
  if (kind === "click") return { clicked: String(args?.ref ?? "") };
  if (kind === "type") return { typed: String(args?.text ?? "") };
  return { key: String(args?.key ?? ""), target: typeof args?.ref === "string" ? String(args.ref) : "page" };
}

/**
 * Watch one tab for removal while an action is in flight.
 *
 * `removed` only ever rejects, so racing it against an injection turns a tab closed mid-action
 * into an immediate failure that the catch then confirms with `tabs.get`. `dispose` must be
 * called when the action settles, so a long-lived tab does not accumulate one listener per action.
 * @param {number} tabId The tab to watch.
 * @returns {{removed: Promise<never>, dispose: () => void}} The watch.
 */
function watchTabRemoval(tabId) {
  /** @type {(removedId: number) => void} */
  let onRemoved = () => {};
  /** @type {Promise<never>} */
  const removed = new Promise((_resolve, reject) => {
    onRemoved = (removedId) => {
      if (removedId === tabId) reject(new Error("the attached tab was closed while the action was running"));
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
  return { removed, dispose: () => { chrome.tabs.onRemoved.removeListener(onRemoved); } };
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

// ---- tab-level actions ----------------------------------------------------

/** Longest wait for a navigation to reach `complete`. */
const TAB_LOAD_TIMEOUT_MS = 15000;

/** How long a navigation gets to start loading before it is treated as same-document. */
const TAB_LOAD_GRACE_MS = 1500;

/** Bound on tab titles reported to the model. */
const MAX_TAB_TITLE_CHARS = 160;

/** JPEG quality for a capture: readable text at a fraction of a PNG's size. */
const SCREENSHOT_JPEG_QUALITY = 75;

/**
 * Longest capture carried, in data-URL characters: well inside the protocol's frame limit, and
 * larger than any ordinary window produces (a 4K capture at this quality is under two million).
 */
const MAX_SCREENSHOT_CHARS = 6 * 1024 * 1024;

/**
 * The opaque reference a model uses for one of its scope's tabs.
 * @param {number} tabId The Chrome tab id.
 * @returns {string} A reference such as `t42`.
 */
function tabRef(tabId) {
  return `t${tabId}`;
}

/**
 * Parse a tab reference.
 * @param {unknown} value The candidate.
 * @returns {number|null} The tab id, or null when the value is not a reference.
 */
function parseTabRef(value) {
  const match = String(value ?? "").match(/^t(\d{1,12})$/);
  return match ? Number(match[1]) : null;
}

/**
 * A URL a session may navigate to.
 *
 * Only ordinary web pages and `about:blank`: a model must not be able to reach `javascript:`,
 * `file:`, or browser-internal pages through a navigation argument.
 * @param {unknown} value The candidate.
 * @returns {string} The validated URL.
 * @throws When the URL is not navigable.
 */
function navigableUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw === "about:blank") return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${raw || "(empty)"} is not a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https pages can be navigated to, not ${url.protocol}`);
  }
  return url.toString();
}

/**
 * One of the scope's tabs as the model sees it.
 * @param {number} tabId The Chrome tab id.
 * @param {number} activeTabId The scope's active tab.
 * @returns {Promise<object|null>} The summary, or null when the tab no longer exists.
 */
async function tabSummary(tabId, activeTabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      tabRef: tabRef(tabId),
      title: String(tab.title ?? "").slice(0, MAX_TAB_TITLE_CHARS),
      url: scrubUrl(String(tab.url ?? tab.pendingUrl ?? "")),
      active: tabId === activeTabId,
    };
  } catch {
    return null;
  }
}

/**
 * Start a navigation and wait for it to settle.
 *
 * Waits for the loading-then-complete transition rather than for a bare `complete`, because the
 * tab is already `complete` before the navigation starts and a bare check would return at once.
 * A navigation that never reports `loading` within the grace period is treated as same-document.
 * @param {number} tabId The tab.
 * @param {() => Promise<unknown>} start Begins the navigation.
 * @returns {Promise<string>} `complete`, `same-document`, or `timeout`.
 * @throws When starting the navigation fails, with Chrome's reason.
 */
async function watchNavigation(tabId, start, expectation = {}) {
  const before = await chrome.tabs.get(tabId).then((tab) => String(tab.url ?? "")).catch(() => "");
  const expectUrlChange = expectation.expectUrlChange === true
    || (typeof expectation.target === "string" && expectation.target !== before);
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(how);
    };
    const listener = (updatedId, info) => {
      if (updatedId !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status !== "complete" || !sawLoading) return;
      // A navigation can report an intermediate `complete` for the document being left before the
      // new document starts loading. Only a tab Chrome says is complete NOW — at a new address when
      // one is expected — counts. Acting on the earlier report (a `back` issued during the in-flight
      // load) cancels the navigation and lands somewhere else entirely.
      chrome.tabs.get(tabId).then((tab) => {
        if (settled || tab.status !== "complete") return;
        if (expectUrlChange && String(tab.url ?? "") === before) return;
        finish("complete");
      }).catch(() => finish("gone"));
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish("timeout"), TAB_LOAD_TIMEOUT_MS);
    const grace = setTimeout(() => { if (!sawLoading) finish("same-document"); }, TAB_LOAD_GRACE_MS);
    start().catch((cause) => {
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      clearTimeout(grace);
      reject(cause);
    });
  });
}

/**
 * Wait for a newly created tab to finish loading.
 * @param {number} tabId The tab.
 * @returns {Promise<void>} Settlement at `complete` or at the deadline.
 */
function waitForTabComplete(tabId, expectedUrl) {
  // A blank tab is complete the moment it exists; anything else must have left about:blank.
  if (expectedUrl === "about:blank") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    // A freshly created tab reports `complete` for its initial blank document before the requested
    // page has even started loading, so the status alone would end the wait too early.
    const check = () => chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && /^https?:/.test(String(tab.url ?? ""))) finish();
    }).catch(finish);
    const listener = (updatedId, info) => { if (updatedId === tabId && info.status === "complete") void check(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, TAB_LOAD_TIMEOUT_MS);
    void check();
  });
}

/**
 * Perform one tab-level action for a scope.
 *
 * Ownership changes made here are written to storage and announced to the broker *before* the
 * result is returned, so the broker's revalidation of a binding-mutating action sees the new
 * ownership on the same ordered socket the result travels on.
 * @param {string} kind The action kind.
 * @param {object} args The arguments.
 * @param {{profileId: string, sessionId: string}} scope The calling scope.
 * @param {object} binding The scope's current binding.
 * @param {number} targetTabId The scope's active tab at dispatch.
 * @returns {Promise<object>} `{ ok: true, data }` or `{ ok: false, error }`.
 */
export async function performTabAction(kind, args, scope, binding, targetTabId) {
  const ok = (data) => ({ ok: true, data });
  const failed = (message) => ({ ok: false, error: { code: ERROR.ACTION_FAILED, message } });
  const gone = (message) => ({ ok: false, error: { code: ERROR.TAB_GONE, message } });

  if (kind === "screenshot") {
    // Chrome captures the active tab of a window, nothing else, so the scope's tab is brought to
    // the front first when it is not already there. That is a visible change for the user and is
    // reported. A page Chrome protects, a minimized window, or a capture Chrome refuses for any
    // other reason is a failure with Chrome's reason, never an image of some other tab.
    let tab;
    try {
      tab = await chrome.tabs.get(targetTabId);
    } catch {
      await releaseClosedTab(targetTabId);
      return gone("the attached tab no longer exists");
    }
    const restricted = restrictionReason(tab);
    if (restricted !== null) return { ok: false, error: { code: ERROR.RESTRICTED_PAGE, message: restricted } };
    let foregrounded = false;
    if (tab.active !== true) {
      try {
        await chrome.tabs.update(targetTabId, { active: true });
        foregrounded = true;
      } catch (cause) {
        return failed(`the tab must be at the front of its window to be captured, and Chrome could not bring it there: ${String(cause?.message ?? cause)}`);
      }
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY });
    } catch (cause) {
      return failed(`Chrome could not capture the tab: ${String(cause?.message ?? cause)}`);
    }
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,")) {
      return failed("Chrome returned no image");
    }
    if (dataUrl.length > MAX_SCREENSHOT_CHARS) {
      return failed(`the capture is ${dataUrl.length} characters, beyond the ${MAX_SCREENSHOT_CHARS} this connector carries; make the window smaller`);
    }
    // The dimensions come from the bytes, not from the window: what the model is told is what
    // it will be given.
    // Decoded from the bytes directly: the extension's own policy does not let the worker fetch a
    // data: URL, and the bytes are already here.
    let width = 0;
    let height = 0;
    try {
      const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch (cause) {
      return failed(`Chrome returned an image this connector could not decode: ${String(cause?.message ?? cause)}`);
    }
    const after = await chrome.tabs.get(targetTabId).catch(() => tab);
    return ok({
      url: scrubUrl(String(after.url ?? tab.url ?? "")),
      title: String(after.title ?? tab.title ?? "").slice(0, MAX_TAB_TITLE_CHARS),
      mediaType: "image/jpeg",
      dataUrl,
      width,
      height,
      foregrounded,
    });
  }

  if (kind === "navigate" || kind === "back" || kind === "forward" || kind === "reload") {
    let how;
    if (kind === "navigate") {
      const url = navigableUrl(args.url);
      how = await watchNavigation(targetTabId, () => chrome.tabs.update(targetTabId, { url }), { target: url });
    } else if (kind === "back") {
      how = await watchNavigation(targetTabId, () => chrome.tabs.goBack(targetTabId), { expectUrlChange: true });
    } else if (kind === "forward") {
      how = await watchNavigation(targetTabId, () => chrome.tabs.goForward(targetTabId), { expectUrlChange: true });
    } else {
      how = await watchNavigation(targetTabId, () => chrome.tabs.reload(targetTabId));
    }
    const summary = await tabSummary(targetTabId, targetTabId);
    if (!summary) {
      await releaseClosedTab(targetTabId);
      return { ok: false, error: { code: ERROR.TAB_GONE, message: "the attached tab no longer exists" } };
    }
    return ok({ ...summary, loaded: how });
  }

  if (kind === "list_tabs") {
    const summaries = [];
    for (const tabId of binding.tabIds) {
      const summary = await tabSummary(tabId, binding.activeTabId);
      if (summary) summaries.push(summary);
      else await releaseClosedTab(tabId);
    }
    const current = lookup(await registry(), scope);
    return ok({
      tabs: summaries,
      activeTabRef: current ? tabRef(current.activeTabId) : null,
    });
  }

  if (kind === "open_tab") {
    const url = args.url === undefined ? "about:blank" : navigableUrl(args.url);
    const opener = await chrome.tabs.get(targetTabId).catch(() => null);
    const created = await chrome.tabs.create({
      url,
      active: true,
      ...(opener && typeof opener.windowId === "number" ? { windowId: opener.windowId, openerTabId: targetTabId } : {}),
    });
    if (typeof created.id !== "number") return failed("Chrome did not report an id for the new tab");
    const current = await registry();
    const next = applyBinding(current, normalizeBinding({
      ...scope,
      tabIds: [...(lookup(current, scope)?.tabIds ?? []), created.id],
      activeTabId: created.id,
    }));
    await write(STORE.BINDINGS, next);
    const updated = lookup(next, scope);
    send({ type: CLIENT.BINDING_UPDATE, ...updated, tabIds: [...updated.tabIds] });
    notifyPanel();
    await waitForTabComplete(created.id, url);
    const summary = await tabSummary(created.id, created.id);
    if (!summary) {
      // The tab vanished between creation and its first report. A partial success would tell the
      // model it owns a tab that does not exist; the binding is cleaned and the truth reported.
      await releaseClosedTab(created.id);
      return gone("the new tab disappeared before it finished loading; it was detached from this session");
    }
    return ok({ opened: tabRef(created.id), ...summary, attachedTabs: updated.tabIds.length });
  }

  if (kind === "switch_tab") {
    const tabId = parseTabRef(args.tabRef);
    if (tabId === null) return failed("tabRef must be a reference from browser_list_tabs, such as t42");
    if (!binding.tabIds.includes(tabId)) {
      return failed(`${args.tabRef} is not attached to this session; use browser_list_tabs to see this session's tabs`);
    }
    // The tab must exist before the scope is pointed at it: pointing a session at a closed tab
    // would leave its next action failing for a reason the model cannot see.
    const exists = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
    if (!exists) {
      await releaseClosedTab(tabId);
      return gone(`${args.tabRef} no longer exists; it was detached from this session`);
    }
    const current = await registry();
    let next;
    try {
      next = setActiveTab(current, scope, tabId);
    } catch (cause) {
      return failed(String(cause?.message ?? cause));
    }
    await write(STORE.BINDINGS, next);
    const updated = lookup(next, scope);
    send({ type: CLIENT.BINDING_UPDATE, ...updated, tabIds: [...updated.tabIds] });
    notifyPanel();
    // The contract has two parts. The scope change above is the security-relevant one and has
    // already happened. Bringing the tab to the front is a courtesy to the user that Chrome may
    // refuse (a tab in a closing window, a picture-in-picture tab); it is reported, not assumed.
    let foregrounded = false;
    try {
      await chrome.tabs.update(tabId, { active: true });
      foregrounded = true;
    } catch {
      foregrounded = false;
    }
    const summary = await tabSummary(tabId, tabId);
    if (!summary) {
      await releaseClosedTab(tabId);
      return gone(`${args.tabRef} disappeared while being made active; it was detached from this session`);
    }
    return ok({ activeTabRef: tabRef(tabId), ...summary, foregrounded });
  }

  if (kind === "close_tab") {
    const tabId = args.tabRef === undefined ? binding.activeTabId : parseTabRef(args.tabRef);
    if (tabId === null) return failed("tabRef must be a reference from browser_list_tabs, such as t42");
    if (!binding.tabIds.includes(tabId)) {
      return failed(`${args.tabRef} is not attached to this session; use browser_list_tabs to see this session's tabs`);
    }
    const exists = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
    if (!exists) {
      await releaseClosedTab(tabId);
      return gone(`${tabRef(tabId)} no longer exists; it was detached from this session`);
    }
    // Authority is withdrawn BEFORE the close is attempted, and stays withdrawn whatever Chrome
    // answers: a session that asked to close a tab must not keep acting in it, and restoring
    // ownership on a failed close would reopen exactly that window.
    const current = await registry();
    const next = detachTab(current, scope, tabId);
    await write(STORE.BINDINGS, next);
    const remaining = lookup(next, scope);
    if (remaining) send({ type: CLIENT.BINDING_UPDATE, ...remaining, tabIds: [...remaining.tabIds] });
    else send({ type: CLIENT.BINDING_REMOVE, ...scope });
    notifyPanel();
    try {
      await chrome.tabs.remove(tabId);
    } catch (cause) {
      // Chrome refused. Reporting "closed" here would tell the model a tab is gone while the user
      // still sees it; the honest result is a failure that also says what did change.
      return failed(
        `${tabRef(tabId)} was detached from this session for safety, but Chrome could not close it: `
        + `${String(cause?.message ?? cause)}`,
      );
    }
    return ok({
      closed: tabRef(tabId),
      remainingTabs: remaining ? remaining.tabIds.length : 0,
      activeTabRef: remaining ? tabRef(remaining.activeTabId) : null,
    });
  }

  return { ok: false, error: { code: ERROR.UNSUPPORTED_ACTION, message: `this extension does not implement ${kind}` } };
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
/** Key in session storage marking the browser session this worker has already seen. */
const BROWSER_SESSION_MARKER = "browserSession";

/**
 * Drop every binding on the first worker start of a browser session.
 *
 * Chrome tab ids are meaningful only within one browser session, and a new session hands them out
 * again from the start, so a binding restored from the previous session could point at an
 * unrelated page that happens to carry the same id — and pass a liveness check. `storage.session`
 * lives in memory for exactly one browser session: a missing marker means this is a new one, and
 * every attachment must be made again by the user. A worker merely evicted and restarted
 * mid-session finds the marker and keeps its bindings.
 */
async function forgetPreviousBrowserSession() {
  const bag = await chrome.storage.session.get(BROWSER_SESSION_MARKER);
  if (bag[BROWSER_SESSION_MARKER]) return;
  await write(STORE.BINDINGS, EMPTY);
  await chrome.storage.session.set({ [BROWSER_SESSION_MARKER]: crypto.randomUUID() });
}

async function wake() {
  await identity();
  await forgetPreviousBrowserSession();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  await validateAgainstLiveTabs();
  await connect();
}

// A fresh worker starts here, whether Chrome created it for an install, a startup, or an event.
void wake();
