// The side panel: a routing and status surface, not a chat client (ADR 0008).
//
// It shows which DeepSeek Harness session controls which tabs, and why an action would not run. It
// never renders page content and never holds the pairing secret beyond handing it to the service
// worker.

import { dictionary, t } from "./i18n.js";
import { PANEL_STATES, resolvePanelState } from "./panel-state.js";

const dict = dictionary();

const el = {
  status: document.getElementById("status"),
  pairing: document.getElementById("pairing"),
  pairingCode: document.getElementById("pairing-code"),
  pairingError: document.getElementById("pairing-error"),
  settings: document.getElementById("settings"),
  settingsToggle: document.getElementById("settings-toggle"),
  brokerUrl: document.getElementById("broker-url"),
  settingsCode: document.getElementById("settings-code"),
  reconnect: document.getElementById("reconnect"),
  versionLine: document.getElementById("version-line"),
  sessions: document.getElementById("sessions"),
  sessionList: document.getElementById("session-list"),
  route: document.getElementById("route"),
  chainSession: document.getElementById("chain-session"),
  chainBrowser: document.getElementById("chain-browser"),
  chainTabs: document.getElementById("chain-tabs"),
  attachedList: document.getElementById("attached-list"),
  attachActive: document.getElementById("attach-active"),
  chooseTabs: document.getElementById("choose-tabs"),
  tabPicker: document.getElementById("tab-picker"),
  tabList: document.getElementById("tab-list"),
  openDsh: document.getElementById("open-dsh"),
};

let snapshot = null;
let pickerOpen = false;

/**
 * Ask the service worker something.
 * @param {object} message The request.
 * @returns {Promise<object>} The reply.
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

/** Replace every element carrying a `data-i18n` key with its localized copy. */
function localizeStaticCopy() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(dict, node.dataset.i18n);
  }
}

/**
 * Build one list row.
 * @param {object} options Row content and controls.
 * @returns {HTMLLIElement} The row.
 */
function row({ title, sub, selected = false, restricted = false, badge = null, buttons = [] }) {
  const item = document.createElement("li");
  if (selected) item.setAttribute("aria-selected", "true");
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
    const chip = document.createElement("span");
    chip.className = "badge";
    if (badge.kind) chip.dataset.kind = badge.kind;
    chip.textContent = badge.label;
    item.append(chip);
  }
  for (const spec of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = spec.primary ? "primary" : "ghost";
    button.textContent = spec.label;
    button.addEventListener("click", spec.onClick);
    item.append(button);
  }
  return item;
}

/**
 * Render the status band.
 * @param {object} state The resolved panel state.
 */
function renderStatus(state) {
  el.status.dataset.tone = state.tone;
  el.status.dataset.state = state.name;
  el.status.replaceChildren();

  const dot = document.createElement("span");
  dot.className = "dot";
  const body = document.createElement("div");
  body.className = "status-body";
  const title = document.createElement("div");
  title.className = "status-title";
  title.textContent = t(dict, state.titleKey);
  const detail = document.createElement("div");
  detail.className = "status-detail";
  detail.textContent = state.name === "update-required" && snapshot?.updateNotice?.reason
    ? snapshot.updateNotice.reason
    : t(dict, state.detailKey, state.values);
  body.append(title, detail);
  el.status.append(dot, body);
}

/** Render the DeepSeek Harness session list. */
function renderSessions() {
  const sessions = snapshot?.brokerState?.sessions ?? [];
  const selected = snapshot?.selectedScope ?? null;
  el.sessionList.replaceChildren();

  if (sessions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t(dict, "noneYet");
    el.sessionList.append(empty);
    return;
  }

  for (const session of sessions) {
    const isSelected = selected?.profileId === session.profileId && selected?.sessionId === session.sessionId;
    const attached = session.tabIds?.length ?? 0;
    el.sessionList.append(row({
      title: session.title || session.sessionId,
      sub: `${session.profileId} · ${attached} tab(s)`,
      selected: isSelected,
      buttons: isSelected ? [] : [{
        label: t(dict, "attach"),
        onClick: async () => {
          await ask({ type: "connector/select-scope", profileId: session.profileId, sessionId: session.sessionId });
          await refresh();
        },
      }],
    }));
  }
}

/** Render the route card: session, browser, and the tabs it owns. */
function renderRoute() {
  const selected = snapshot?.selectedScope ?? null;
  const sessions = snapshot?.brokerState?.sessions ?? [];
  const session = selected
    ? sessions.find((entry) => entry.profileId === selected.profileId && entry.sessionId === selected.sessionId)
    : undefined;
  const binding = selected
    ? (snapshot?.bindings ?? []).find((entry) => (
        entry.profileId === selected.profileId && entry.sessionId === selected.sessionId
      ))
    : undefined;

  el.chainSession.textContent = session ? (session.title || session.sessionId) : "—";
  el.chainBrowser.textContent = snapshot?.identity?.browserName ?? "Chrome";
  el.chainTabs.textContent = String(binding?.tabIds?.length ?? 0);

  el.attachedList.replaceChildren();
  if (!binding || binding.tabIds.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t(dict, "stateNoTabsDetail");
    el.attachedList.append(empty);
    return;
  }

  for (const tabId of binding.tabIds) {
    const known = (snapshot?.tabs ?? []).find((tab) => tab.id === tabId);
    const isActive = binding.activeTabId === tabId;
    const buttons = [];
    if (!isActive) {
      buttons.push({
        label: t(dict, "makeActive"),
        onClick: async () => {
          await ask({ type: "connector/set-active-tab", ...selected, tabId });
          await refresh();
        },
      });
    }
    buttons.push({
      label: t(dict, "detach"),
      onClick: async () => {
        await ask({ type: "connector/detach", ...selected, tabId });
        await refresh();
      },
    });
    el.attachedList.append(row({
      title: known?.title || `Tab ${tabId}`,
      sub: known?.url ?? "",
      badge: isActive ? { label: t(dict, "activeBadge"), kind: "active" } : null,
      buttons,
    }));
  }
}

/** Render the tab picker. */
function renderPicker() {
  el.tabPicker.hidden = !pickerOpen;
  if (!pickerOpen) return;
  const selected = snapshot?.selectedScope ?? null;
  const attached = new Set(
    (snapshot?.bindings ?? [])
      .filter((entry) => entry.profileId === selected?.profileId && entry.sessionId === selected?.sessionId)
      .flatMap((entry) => entry.tabIds),
  );
  el.tabList.replaceChildren();
  for (const tab of snapshot?.tabs ?? []) {
    if (attached.has(tab.id)) continue;
    el.tabList.append(row({
      title: tab.title || `Tab ${tab.id}`,
      sub: tab.url,
      restricted: tab.restricted,
      badge: tab.restricted ? { label: t(dict, "restrictedBadge") } : null,
      buttons: tab.restricted ? [] : [{
        label: t(dict, "attach"),
        primary: true,
        onClick: async () => {
          const reply = await ask({ type: "connector/attach", ...selected, tabId: tab.id });
          if (reply?.ok !== true) window.alert(reply?.error ?? "That tab could not be attached.");
          pickerOpen = false;
          await refresh();
        },
      }],
    }));
  }
  if (el.tabList.childElementCount === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t(dict, "noneYet");
    el.tabList.append(empty);
  }
}

/** Read the current state and redraw everything. */
async function refresh() {
  const state = await ask({ type: "connector/state" });
  if (state?.ok !== true) return;
  const tabs = await ask({ type: "connector/tabs" });
  snapshot = { ...state, tabs: tabs?.ok === true ? tabs.tabs : [] };

  const panel = resolvePanelState(snapshot);
  renderStatus(panel);

  el.pairing.hidden = !panel.showPairing;
  el.sessions.hidden = !panel.showSessions;
  el.route.hidden = !panel.showRoute;
  if (!panel.showRoute) pickerOpen = false;

  if (panel.showSessions) renderSessions();
  if (panel.showRoute) { renderRoute(); renderPicker(); }

  el.brokerUrl.value = snapshot.settings?.brokerUrl ?? "";
  el.settingsCode.value = snapshot.settings?.pairingCode ?? "";
  el.versionLine.textContent = [
    `extension ${snapshot.extensionVersion}`,
    `protocol ${snapshot.protocolVersion}`,
    snapshot.brokerState?.brokerVersion ? `connector ${snapshot.brokerState.brokerVersion}` : null,
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
  await refresh();
});

el.settingsToggle.addEventListener("click", () => {
  const open = el.settings.hidden;
  el.settings.hidden = !open;
  el.settingsToggle.setAttribute("aria-expanded", String(open));
});

el.reconnect.addEventListener("click", async () => {
  await ask({ type: "connector/reconnect" });
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

el.chooseTabs.addEventListener("click", async () => {
  pickerOpen = !pickerOpen;
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "connector/changed") void refresh();
});

localizeStaticCopy();
void refresh();

/** Exported for the panel-state tests, which assert every state is reachable. */
export { PANEL_STATES, looksLikePairingCode };
