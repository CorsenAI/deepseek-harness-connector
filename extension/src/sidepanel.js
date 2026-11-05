// The side panel: a routing and status surface, not a chat client (ADR 0008).
//
// It shows which DeepSeek Harness session controls which tabs, and why an action would not run. It
// never renders page content beyond the titles and addresses of tabs, always as text, and never holds
// the pairing secret beyond handing it to the service worker.
//
// The layout follows Corsen's Hermes Connector: one status strip, one compact scope strip with the
// session and the tab it acts in, popovers for the tab list, the access notes and the settings, and a
// single card for whatever the user should know next.

import { dictionary, t } from "./i18n.js";
import { PANEL_STATES, classifyProbe, onboardingFor, resolvePanelState } from "./panel-state.js";

/** This extension's version; the companion the setup card names must be the same one. */
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const dict = dictionary();

/**
 * One element by id, typed for the checker.
 * @template {HTMLElement} T
 * @param {string} id The element id.
 * @returns {T} The element.
 */
function byId(id) {
  return /** @type {T} */ (/** @type {unknown} */ (document.getElementById(id)));
}

const el = {
  dot: byId("dot"),
  status: byId("status"),
  settingsToggle: byId("settings-toggle"),
  settings: /** @type {HTMLFormElement} */ (byId("settings")),
  brokerUrl: /** @type {HTMLInputElement} */ (byId("broker-url")),
  settingsCode: /** @type {HTMLInputElement} */ (byId("settings-code")),
  reconnect: byId("reconnect"),
  versionLine: byId("version-line"),
  sessions: byId("sessions"),
  sessionSelect: /** @type {HTMLSelectElement} */ (byId("session-select")),
  refreshButton: byId("refresh"),
  route: byId("route"),
  target: byId("target"),
  attachActive: /** @type {HTMLButtonElement} */ (byId("attach-active")),
  chooseTabs: byId("choose-tabs"),
  tabCount: byId("tab-count"),
  aboutToggle: byId("about-toggle"),
  about: byId("about"),
  tabPicker: byId("tab-picker"),
  attachedList: byId("attached-list"),
  tabList: byId("tab-list"),
  onboarding: byId("onboarding"),
  onboardingDetection: byId("onboarding-detection"),
  onboardingStepInstall: byId("onboarding-step-install"),
  onboardingInstaller: byId("onboarding-installer"),
  onboardingCheck: byId("onboarding-check"),
  cmdInstall: byId("cmd-install"),
  cmdCode: byId("cmd-code"),
  pairing: /** @type {HTMLFormElement} */ (byId("pairing")),
  pairingCode: /** @type {HTMLInputElement} */ (byId("pairing-code")),
  pairingError: byId("pairing-error"),
  card: byId("card"),
  cardTitle: byId("card-title"),
  cardDetail: byId("card-detail"),
  routeLine: byId("route-line"),
  routeSession: byId("route-session"),
  routeBrowser: byId("route-browser"),
  routeTabs: byId("route-tabs"),
};

let snapshot = null;

/** Chrome's name for this operating system, read once. */
let platformOs;
/** The last probe of the connector address: `checking` until the first answer. */
let probe = /** @type {"checking"|"running"|"other"|"none"} */ ("checking");
/** The address the last probe was for, so a changed setting is probed afresh. */
let probedUrl = null;
/** Re-probes while the setup sheet is showing, so a connector started meanwhile is noticed. */
let probeTimer = null;
const PROBE_EVERY_MS = 4000;

/**
 * Ask the service worker something.
 * @param {object} message The request.
 * @returns {Promise<any>} The reply.
 */
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (cause) {
    // The worker was evicted between the click and the send. Chrome restarts it for the next
    // message, so the panel reports rather than pretending the action succeeded.
    return { ok: false, error: String(cause?.message ?? cause) };
  }
}

/** Fill every element carrying `data-i18n` with its copy, and every `data-i18n-label` with its name. */
function localizeStaticCopy() {
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-i18n]"))) {
    node.textContent = t(dict, node.dataset.i18n ?? "");
  }
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-i18n-label]"))) {
    const label = t(dict, node.dataset.i18nLabel ?? "");
    node.setAttribute("aria-label", label);
    if (node.tagName === "BUTTON") node.title = label;
  }
}

/**
 * The profile name inside a routing profile id (`<name>.<twelve hex>`), for display.
 * @param {string} profileId The id.
 * @returns {string} The readable name.
 */
function profileName(profileId) {
  const cut = String(profileId).lastIndexOf(".");
  return cut > 0 ? profileId.slice(0, cut) : String(profileId);
}

/**
 * Build one row of a popover list.
 * @param {object} options Row content and controls.
 * @param {string} options.title The main line.
 * @param {string} [options.sub] The second line.
 * @param {boolean} [options.current] Whether this is the session's active tab.
 * @param {boolean} [options.restricted] Whether Chrome forbids acting there.
 * @param {string|null} [options.badge] A short note at the end.
 * @param {{label: string, primary?: boolean, onClick: () => void}[]} [options.buttons] The controls.
 * @returns {HTMLLIElement} The row.
 */
function row({ title, sub = "", current = false, restricted = false, badge = null, buttons = [] }) {
  const item = document.createElement("li");
  if (current) item.setAttribute("aria-current", "true");
  if (restricted) item.dataset.restricted = "true";

  const grow = document.createElement("div");
  grow.className = "grow";
  const titleLine = document.createElement("span");
  titleLine.className = "title";
  // `textContent` throughout: a tab title is page-controlled text and must never become markup.
  titleLine.textContent = title;
  grow.append(titleLine);
  if (sub) {
    const subLine = document.createElement("span");
    subLine.className = "sub";
    subLine.textContent = sub;
    grow.append(subLine);
  }
  item.append(grow);

  if (badge) {
    const note = document.createElement("span");
    note.className = "badge";
    note.textContent = badge;
    item.append(note);
  }
  for (const spec of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = spec.primary ? "small primary" : "small";
    button.textContent = spec.label;
    button.addEventListener("click", spec.onClick);
    item.append(button);
  }
  return item;
}

/**
 * An empty-list line.
 * @param {string} key The dictionary key.
 * @returns {HTMLLIElement} The line.
 */
function emptyRow(key) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = t(dict, key);
  return item;
}

/** The session the user selected, its binding, and the tabs Chrome reported, in one place. */
function selection() {
  const selected = snapshot?.selectedScope ?? null;
  const sessions = snapshot?.brokerState?.sessions ?? [];
  const session = selected
    ? sessions.find((entry) => entry.profileId === selected.profileId && entry.sessionId === selected.sessionId)
    : undefined;
  const binding = selected
    ? (snapshot?.bindings ?? []).find((entry) => entry.profileId === selected.profileId && entry.sessionId === selected.sessionId)
    : undefined;
  return { selected, session, binding, tabs: snapshot?.tabs ?? [] };
}

/**
 * The strip's line for a state: the connection, not the task. The card below says what to do next,
 * so the strip never repeats it.
 * @param {ReturnType<typeof resolvePanelState>} state The resolved panel state.
 * @returns {string} The line.
 */
function headline(state) {
  switch (state.name) {
    case "first-run":
    case "unpaired": return t(dict, "headlineNotPaired");
    case "pairing": return t(dict, "headlinePairing");
    case "disconnected": return t(dict, "headlineUnreachable");
    case "update-required": return t(dict, "stateUpdateTitle");
    default: return t(dict, "headlineConnected", { count: snapshot?.brokerState?.sessions?.length ?? 0 });
  }
}

/**
 * Render the strip: the dot's tone and the connection line.
 * @param {ReturnType<typeof resolvePanelState>} state The resolved panel state.
 */
function renderStrip(state) {
  el.dot.dataset.tone = state.tone;
  el.status.dataset.tone = state.tone;
  el.status.dataset.state = state.name;
  el.status.textContent = headline(state);
}

/** Render the session selector. */
function renderSessions() {
  const sessions = snapshot?.brokerState?.sessions ?? [];
  const { selected } = selection();
  el.sessionSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t(dict, sessions.length === 0 ? "sessionNone" : "sessionPlaceholder");
  el.sessionSelect.append(placeholder);

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = JSON.stringify([session.profileId, session.sessionId]);
    const attached = session.tabIds?.length ?? 0;
    option.textContent = t(dict, "sessionOption", {
      title: session.title || session.sessionId,
      profile: profileName(session.profileId),
      count: attached,
    });
    if (selected?.profileId === session.profileId && selected?.sessionId === session.sessionId) option.selected = true;
    el.sessionSelect.append(option);
  }
  el.sessionSelect.disabled = sessions.length === 0;
  if (!selected || !sessions.some((entry) => entry.profileId === selected.profileId && entry.sessionId === selected.sessionId)) {
    placeholder.selected = true;
  }
}

/** Render the target row: the tab the session acts in, and how many it has. */
function renderTarget() {
  const { selected, binding, tabs } = selection();
  const count = binding?.tabIds?.length ?? 0;
  el.tabCount.textContent = count > 0 ? ` (${count})` : "";
  el.target.replaceChildren();

  if (!selected || !binding || count === 0) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = t(dict, "stateNoTabsTitle");
    el.target.append(none);
    return;
  }
  const activeId = binding.activeTabId ?? binding.tabIds[0];
  const known = tabs.find((tab) => tab.id === activeId);
  const current = document.createElement("span");
  current.className = "current";
  current.textContent = known?.title || known?.url || `Tab ${activeId}`;
  current.title = known?.url ?? "";
  const detach = document.createElement("button");
  detach.type = "button";
  detach.className = "small detach";
  detach.textContent = "×";
  detach.setAttribute("aria-label", t(dict, "detach"));
  detach.title = t(dict, "detach");
  detach.addEventListener("click", async () => {
    await ask({ type: "connector/detach", ...selected, tabId: activeId });
    await refresh();
  });
  el.target.append(current, detach);
}

/** Render the tab popover: this session's tabs first, then the tabs that can be attached. */
function renderPicker() {
  if (el.tabPicker.hidden) return;
  const { selected, binding, tabs } = selection();
  const attachedIds = binding?.tabIds ?? [];

  el.attachedList.replaceChildren();
  for (const tabId of attachedIds) {
    const known = tabs.find((tab) => tab.id === tabId);
    const isActive = binding?.activeTabId === tabId;
    const buttons = [];
    if (!isActive) {
      buttons.push({
        label: t(dict, "makeActive"),
        onClick: async () => { await ask({ type: "connector/set-active-tab", ...selected, tabId }); await refresh(); },
      });
    }
    buttons.push({
      label: t(dict, "detach"),
      onClick: async () => { await ask({ type: "connector/detach", ...selected, tabId }); await refresh(); },
    });
    el.attachedList.append(row({
      title: known?.title || `Tab ${tabId}`,
      sub: known?.url ?? "",
      current: isActive,
      badge: isActive ? t(dict, "activeBadge") : null,
      buttons,
    }));
  }
  if (attachedIds.length === 0) el.attachedList.append(emptyRow("noneYet"));

  el.tabList.replaceChildren();
  const attached = new Set(attachedIds);
  for (const tab of tabs) {
    if (attached.has(tab.id)) continue;
    el.tabList.append(row({
      title: tab.title || `Tab ${tab.id}`,
      sub: tab.url,
      restricted: tab.restricted,
      badge: tab.restricted ? t(dict, "restrictedBadge") : null,
      buttons: tab.restricted ? [] : [{
        label: t(dict, "attach"),
        primary: true,
        onClick: async () => {
          const reply = await ask({ type: "connector/attach", ...selected, tabId: tab.id });
          if (reply?.ok !== true) window.alert(reply?.error ?? "That tab could not be attached.");
          await refresh();
        },
      }],
    }));
  }
  if (el.tabList.childElementCount === 0) el.tabList.append(emptyRow("noneYet"));
}

/**
 * Render the card: the state's title and next step, or, when a session can act, the route itself.
 * @param {ReturnType<typeof resolvePanelState>} state The resolved panel state.
 */
function renderCard(state) {
  el.card.dataset.tone = state.tone;
  el.cardTitle.textContent = t(dict, state.titleKey);
  const { session, binding } = selection();
  const showRoute = state.showRoute && session !== undefined;
  el.routeLine.hidden = !showRoute;
  if (showRoute) {
    const count = binding?.tabIds?.length ?? 0;
    el.routeSession.textContent = session.title || session.sessionId;
    el.routeBrowser.textContent = snapshot?.identity?.browserName ?? "Chrome";
    el.routeTabs.textContent = t(dict, "routeTabs", { count });
  }
  // The update state says why (the broker's own reason when it gave one) and then the one command
  // that fixes it: the install command of this extension's version (ADR 0011).
  el.cardDetail.textContent = state.name === "update-required"
    ? `${snapshot?.updateNotice?.reason || t(dict, state.detailKey, state.values)} ${t(dict, "stateUpdateFix", state.values)}`
    : state.name === "ready"
      ? t(dict, "cardReadyHint")
      : t(dict, state.detailKey, state.values);
}

/**
 * Ask the connector address whether the broker is there.
 *
 * A plain GET to the broker's HTTP side: the broker answers 426 and nothing else. Loopback only,
 * from the extension's own origin; nothing about this leaves the machine. The status is read from
 * the answer rather than assumed from the absence of an error.
 * @param {string} url The probe address.
 * @returns {Promise<number|null>} The status, or null when nothing answered.
 */
async function probeBroker(url) {
  try {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { method: "GET", cache: "no-store", redirect: "manual", signal: controller.signal });
    clearTimeout(deadline);
    return response.status;
  } catch {
    return null;
  }
}

/** Probe now and redraw the setup sheet with the verdict. */
async function runProbe() {
  const card = onboardingFor({ platformOs, probe, brokerUrl: snapshot?.settings?.brokerUrl ?? "", version: EXTENSION_VERSION });
  if (card.probeUrl === null) { probe = "none"; renderOnboarding(); return; }
  probedUrl = card.probeUrl;
  const status = await probeBroker(card.probeUrl);
  // The setting may have changed while the request was out; only the current address's answer counts.
  if (probedUrl !== card.probeUrl) return;
  probe = classifyProbe(status);
  renderOnboarding();
}

/** Render the setup sheet from what is known now. */
function renderOnboarding() {
  const card = onboardingFor({ platformOs, probe, brokerUrl: snapshot?.settings?.brokerUrl ?? "", version: EXTENSION_VERSION });
  const values = { url: card.probeUrl ? new URL(card.probeUrl).host : String(snapshot?.settings?.brokerUrl ?? ""), os: t(dict, card.osKey) };
  el.onboardingDetection.dataset.tone = card.tone;
  el.onboardingDetection.textContent = t(dict, card.detectionKey, values);
  el.onboardingStepInstall.textContent = t(dict, "onboardingStepInstall", values);
  el.onboardingInstaller.textContent = t(dict, card.installerKey);
  el.cmdInstall.textContent = card.installCommand;
  el.cmdCode.textContent = card.codeCommand;
  el.onboarding.dataset.os = card.os;
  el.onboarding.dataset.probe = probe;
}

/**
 * Keep probing while the sheet shows; stop when it does not.
 * @param {boolean} visible Whether the setup sheet is on screen.
 */
function scheduleProbes(visible) {
  if (!visible) {
    if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; }
    return;
  }
  if (probeTimer === null) {
    void runProbe();
    probeTimer = setInterval(() => { void runProbe(); }, PROBE_EVERY_MS);
  }
}

/** Read the current state and redraw everything. */
async function refresh() {
  const state = await ask({ type: "connector/state" });
  if (state?.ok !== true) return;
  const tabs = await ask({ type: "connector/tabs" });
  snapshot = { ...state, tabs: tabs?.ok === true ? tabs.tabs : [] };

  const panel = resolvePanelState(snapshot);
  renderStrip(panel);

  el.sessions.hidden = !panel.showSessions;
  el.route.hidden = !panel.showRoute;
  el.onboarding.hidden = !panel.showOnboarding;
  el.pairing.hidden = !panel.showPairing;
  el.card.hidden = panel.showOnboarding;
  if (!panel.showRoute) closePopover(el.tabPicker, el.chooseTabs);

  if (panel.showOnboarding) {
    // A changed address is probed at once rather than described by an old verdict.
    const card = onboardingFor({ platformOs, probe, brokerUrl: snapshot.settings?.brokerUrl ?? "", version: EXTENSION_VERSION });
    const changed = card.probeUrl !== probedUrl;
    if (changed) probe = "checking";
    renderOnboarding();
    if (changed && probeTimer !== null) void runProbe();
  } else {
    renderCard(panel);
  }
  scheduleProbes(panel.showOnboarding);

  if (panel.showSessions) renderSessions();
  if (panel.showRoute) { renderTarget(); renderPicker(); }

  if (document.activeElement !== el.brokerUrl) el.brokerUrl.value = snapshot.settings?.brokerUrl ?? "";
  if (document.activeElement !== el.settingsCode) el.settingsCode.value = snapshot.settings?.pairingCode ?? "";
  el.versionLine.textContent = [
    `extension ${snapshot.extensionVersion}`,
    `protocol ${snapshot.protocolVersion}`,
    snapshot.brokerState?.brokerVersion ? `connector ${snapshot.brokerState.brokerVersion}` : null,
    t(dict, "byline"),
  ].filter(Boolean).join(" · ");
}

/**
 * Whether a typed code can be a pairing code.
 *
 * Checked before sending so a mistyped code produces an immediate, specific message instead of a
 * silent failed handshake the user would have to interpret from a connection state.
 * @param {string} entered What the user typed.
 * @returns {boolean} Whether it has the right shape.
 */
function looksLikePairingCode(entered) {
  return /^[34679ACDEFGHJKMNPQRTUVWXY]{20}$/.test(
    String(entered ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
  );
}

// ---- popovers ---------------------------------------------------------------

const POPOVERS = /** @type {[HTMLElement, HTMLElement][]} */ ([
  [el.settings, el.settingsToggle],
  [el.tabPicker, el.chooseTabs],
  [el.about, el.aboutToggle],
]);

/**
 * Close one popover.
 * @param {HTMLElement} popover The popover.
 * @param {HTMLElement} toggle Its button.
 */
function closePopover(popover, toggle) {
  popover.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
}

/**
 * Open one popover and close the others.
 * @param {HTMLElement} popover The popover.
 * @param {HTMLElement} toggle Its button.
 */
function togglePopover(popover, toggle) {
  const open = popover.hidden;
  for (const [other, otherToggle] of POPOVERS) closePopover(other, otherToggle);
  popover.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const [popover, toggle] of POPOVERS) {
    if (!popover.hidden) { closePopover(popover, toggle); toggle.focus(); }
  }
});

document.addEventListener("click", (event) => {
  const target = /** @type {Node} */ (event.target);
  for (const [popover, toggle] of POPOVERS) {
    if (!popover.hidden && !popover.contains(target) && !toggle.contains(target)) closePopover(popover, toggle);
  }
});

// ---- controls ---------------------------------------------------------------

el.pairing.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entered = el.pairingCode.value;
  if (!looksLikePairingCode(entered)) {
    el.pairingError.textContent = t(dict, "pairingCodeInvalid");
    el.pairingError.hidden = false;
    return;
  }
  el.pairingError.hidden = true;
  await ask({ type: "connector/settings", settings: { pairingCode: entered } });
  await refresh();
});

el.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  await ask({
    type: "connector/settings",
    settings: { brokerUrl: el.brokerUrl.value.trim(), pairingCode: el.settingsCode.value },
  });
  closePopover(el.settings, el.settingsToggle);
  await refresh();
});

el.settingsToggle.addEventListener("click", () => { togglePopover(el.settings, el.settingsToggle); });
el.aboutToggle.addEventListener("click", () => { togglePopover(el.about, el.aboutToggle); });
el.chooseTabs.addEventListener("click", async () => {
  togglePopover(el.tabPicker, el.chooseTabs);
  await refresh();
});

el.reconnect.addEventListener("click", async () => {
  await ask({ type: "connector/reconnect" });
  await refresh();
});

el.refreshButton.addEventListener("click", () => { void refresh(); });

el.sessionSelect.addEventListener("change", async () => {
  if (el.sessionSelect.value === "") return;
  const [profileId, sessionId] = /** @type {[string, string]} */ (JSON.parse(el.sessionSelect.value));
  await ask({ type: "connector/select-scope", profileId, sessionId });
  await refresh();
});

el.attachActive.addEventListener("click", async () => {
  const selected = snapshot?.selectedScope;
  if (!selected) return;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active || typeof active.id !== "number") return;
  const reply = await ask({ type: "connector/attach", ...selected, tabId: active.id });
  if (reply?.ok !== true) window.alert(reply?.error ?? "That tab could not be attached.");
  await refresh();
});

el.onboardingCheck.addEventListener("click", async () => {
  probe = "checking";
  renderOnboarding();
  await runProbe();
});

for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll("button.copy"))) {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy ?? "");
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent ?? "");
      button.textContent = t(dict, "copied");
      setTimeout(() => { button.textContent = t(dict, "copy"); }, 1500);
    } catch {
      // The clipboard can be refused (no user activation, a policy); the text is on screen anyway.
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "connector/changed") void refresh();
});

localizeStaticCopy();
chrome.runtime.getPlatformInfo().then((info) => { platformOs = info?.os; renderOnboardingIfShown(); }, () => {});
void refresh();

/** Redraw the setup sheet when it is on screen; the platform arrives after the first paint. */
function renderOnboardingIfShown() {
  if (el.onboarding && !el.onboarding.hidden && snapshot) renderOnboarding();
}

/** Exported for the panel-state tests, which assert every state is reachable. */
export { PANEL_STATES, looksLikePairingCode };
