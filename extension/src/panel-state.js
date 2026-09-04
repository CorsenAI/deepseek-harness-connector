// Which panel state one snapshot of connector state means.
//
// Split out from the panel's DOM code so every state in ADR 0008 is decided by a pure function and
// can be tested without a browser. The panel then only has to render what this returns. Getting
// this wrong is not cosmetic: the status band is the only place a user learns why an agent did
// nothing, so a state that resolves to the wrong message is a product failure.

/**
 * @typedef {object} ConnectorSnapshot
 * @property {boolean} connected Whether the broker accepted this browser.
 * @property {{brokerUrl: string, pairingCode: string}} settings The user's settings.
 * @property {{pairedAt: string}|null} paired When this browser last paired.
 * @property {{required: boolean, reason?: string}|null} updateNotice A refusal that retrying cannot fix.
 * @property {{brokerVersion: string|null, sessions: object[]}|null} brokerState The broker's last projection.
 * @property {object[]} bindings This browser's bindings.
 * @property {{profileId: string, sessionId: string}|null} selectedScope The session the user picked.
 */

/**
 * @typedef {object} PanelState
 * @property {string} name A stable identifier, used by tests and by the renderer.
 * @property {"ok"|"warn"|"bad"|"busy"|"idle"} tone How prominently to present it.
 * @property {string} titleKey The dictionary key for the heading.
 * @property {string} detailKey The dictionary key for the explanation.
 * @property {Record<string, string|number>} values Placeholder values for the detail.
 * @property {boolean} showPairing Whether the pairing form is visible.
 * @property {boolean} showSessions Whether the session list is visible.
 * @property {boolean} showRoute Whether the route card is visible.
 */

/**
 * Decide which state one snapshot means.
 *
 * The order below is the order of what blocks what: a version mismatch makes everything else moot,
 * an unpaired browser cannot list sessions, and a session with no tabs cannot act. Each branch
 * returns the first state that is actually true, so the user is told the nearest cause rather than
 * the last symptom.
 * @param {ConnectorSnapshot} snapshot The current connector state.
 * @returns {PanelState} The state to render.
 */
export function resolvePanelState(snapshot) {
  const settings = snapshot?.settings ?? { brokerUrl: "", pairingCode: "" };
  const hasCode = String(settings.pairingCode ?? "").trim() !== "";
  const sessions = snapshot?.brokerState?.sessions ?? [];
  const selected = snapshot?.selectedScope ?? null;

  const state = (name, tone, titleKey, detailKey, values = {}, panels = {}) => ({
    name,
    tone,
    titleKey,
    detailKey,
    values,
    showPairing: panels.showPairing ?? false,
    showSessions: panels.showSessions ?? false,
    showRoute: panels.showRoute ?? false,
  });

  if (snapshot?.updateNotice?.required === true) {
    return state("update-required", "bad", "stateUpdateTitle", "stateUpdateDetail", {}, { showPairing: false });
  }

  if (!hasCode) {
    // A browser that has never been paired is not broken, so this reads as a welcome rather than an
    // error. It is the only state where the pairing form is the whole point of the panel.
    return state(
      snapshot?.paired ? "unpaired" : "first-run",
      "idle",
      snapshot?.paired ? "stateUnpairedTitle" : "stateFirstRunTitle",
      snapshot?.paired ? "stateUnpairedDetail" : "stateFirstRunDetail",
      {},
      { showPairing: true },
    );
  }

  if (!snapshot?.connected) {
    return snapshot?.paired
      ? state("disconnected", "warn", "stateDisconnectedTitle", "stateDisconnectedDetail", { url: settings.brokerUrl })
      : state("pairing", "busy", "statePairingTitle", "statePairingDetail", {}, { showPairing: true });
  }

  if (sessions.length === 0) {
    return state("no-sessions", "warn", "stateNoSessionsTitle", "stateNoSessionsDetail", {}, { showSessions: true });
  }

  const chosen = selected
    ? sessions.find((entry) => entry.profileId === selected.profileId && entry.sessionId === selected.sessionId)
    : undefined;
  if (!chosen) {
    return state("no-selection", "idle", "stateNoSelectionTitle", "stateNoSelectionDetail", {}, { showSessions: true });
  }

  const binding = (snapshot?.bindings ?? []).find((entry) => (
    entry.profileId === chosen.profileId && entry.sessionId === chosen.sessionId
  ));
  const count = binding?.tabIds?.length ?? 0;
  if (count === 0) {
    return state("no-tabs", "warn", "stateNoTabsTitle", "stateNoTabsDetail", {}, { showSessions: true, showRoute: true });
  }

  return state(
    "ready",
    "ok",
    "stateReadyTitle",
    "stateReadyDetail",
    { session: chosen.title ?? chosen.sessionId, count },
    { showSessions: true, showRoute: true },
  );
}

/** Every state name this module can produce, so a test can prove each one is reachable. */
export const PANEL_STATES = Object.freeze([
  "first-run",
  "unpaired",
  "pairing",
  "disconnected",
  "no-sessions",
  "no-selection",
  "no-tabs",
  "ready",
  "update-required",
]);
