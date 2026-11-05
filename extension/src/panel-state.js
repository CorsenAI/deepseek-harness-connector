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
 * @property {string} [extensionVersion] This extension's version, which the companion must match.
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
 * @property {boolean} showOnboarding Whether the first-run card (install, start, pair) is visible.
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
    // Every state that shows the pairing form is a state in which the user may not have the
    // companion yet, so the setup card travels with it.
    showOnboarding: panels.showPairing ?? false,
    showSessions: panels.showSessions ?? false,
    showRoute: panels.showRoute ?? false,
  });

  if (snapshot?.updateNotice?.required === true) {
    // A companion from a release is pinned to its URL, so moving on is the install command of this
    // extension's version again, not a package manager's update: the state says which command.
    return state("update-required", "bad", "stateUpdateTitle", "stateUpdateDetail", { command: installCommandFor(snapshot.extensionVersion ?? "") }, { showPairing: false });
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

/**
 * The operating system the setup card speaks to, from `chrome.runtime.getPlatformInfo().os`.
 * @param {string|undefined} platformOs Chrome's value: `win`, `mac`, `linux`, `cros`, `openbsd`, …
 * @returns {"windows"|"mac"|"linux"|"other"} The family the instructions are written for.
 */
export function osFamily(platformOs) {
  switch (String(platformOs ?? "")) {
    case "win": return "windows";
    case "mac": return "mac";
    case "linux":
    case "openbsd": return "linux";
    default: return "other";
  }
}

/**
 * The plain-HTTP address of a broker WebSocket address, which is what a reachability probe fetches.
 * @param {string} brokerUrl The user's connector address, such as `ws://127.0.0.1:8781`.
 * @returns {string|null} The probe address, or null when the setting is not a WebSocket address.
 */
export function probeUrlFor(brokerUrl) {
  let parsed;
  try {
    parsed = new URL(String(brokerUrl ?? ""));
  } catch {
    return null;
  }
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else return null;
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

/**
 * What one probe of the broker address means.
 *
 * The broker answers a plain request with `426 Upgrade Required` and nothing else, which no
 * ordinary web server does; a different status is some other program on the port, and no answer
 * at all is nothing listening.
 * @param {number|null} status The HTTP status the address answered with, or null for no answer.
 * @returns {"running"|"other"|"none"} The verdict.
 */
export function classifyProbe(status) {
  if (status === 426) return "running";
  if (typeof status === "number" && status > 0) return "other";
  return "none";
}

/**
 * Where a release's companion is published: the project's own GitHub release of that version. The
 * companion is not on a package registry; `dsh plugin add` downloads the tarball from here, as it
 * downloads any tarball URL (ADR 0011).
 */
export const RELEASE_DOWNLOADS = "https://github.com/CorsenAI/deepseek-harness-connector/releases/download";

/**
 * The companion tarball of one version, as `dsh plugin add` fetches it.
 *
 * The extension and the companion must be the same version (ADR 0004), so the command the panel
 * shows is built from the extension's own version: whatever release the user has, the command
 * names its pair.
 * @param {string} version The extension's version, `major.minor.patch`.
 * @returns {string} The tarball's URL on the release of that version.
 */
export function companionTarballUrl(version) {
  return `${RELEASE_DOWNLOADS}/v${version}/corsen-ai-dsh-browser-connector-${version}.tgz`;
}

/**
 * The one command that installs the companion of this extension's version into a profile.
 * @param {string} version The extension's version.
 * @param {string} [profile] The DeepSeek Harness profile, `web` by default.
 * @returns {string} The command, as the user types it.
 */
export function installCommandFor(version, profile = "web") {
  return `dsh plugin --profile ${profile} add ${companionTarballUrl(version)}`;
}

/**
 * Everything the setup card shows, decided without touching the DOM.
 * @param {object} input What is known.
 * @param {string|undefined} input.platformOs Chrome's platform name.
 * @param {"checking"|"running"|"other"|"none"} input.probe The last probe's verdict.
 * @param {string} input.brokerUrl The connector address setting.
 * @param {string} input.version The extension's own version; the companion must be the same one.
 * @returns {{
 *   os: "windows"|"mac"|"linux"|"other",
 *   osKey: string,
 *   detectionKey: string,
 *   tone: "ok"|"warn"|"busy"|"idle",
 *   installCommand: string,
 *   codeCommand: string,
 *   installerKey: string,
 *   probeUrl: string|null,
 * }} What to render.
 */
export function onboardingFor({ platformOs, probe, brokerUrl, version }) {
  const os = osFamily(platformOs);
  const detection = {
    checking: ["onboardingChecking", "busy"],
    running: ["onboardingDetected", "ok"],
    other: ["onboardingOtherProgram", "warn"],
    none: ["onboardingNotDetected", "idle"],
  }[probe] ?? ["onboardingNotDetected", "idle"];
  return {
    os,
    osKey: { windows: "osWindows", mac: "osMac", linux: "osLinux", other: "osOther" }[os],
    detectionKey: detection[0],
    tone: /** @type {"ok"|"warn"|"busy"|"idle"} */ (detection[1]),
    installCommand: installCommandFor(version),
    codeCommand: "dsh plugin --profile web exec dsh-connector-broker --pairing-code",
    installerKey: os === "windows" ? "onboardingInstallerWindows" : "onboardingInstallerPosix",
    probeUrl: probeUrlFor(brokerUrl),
  };
}

