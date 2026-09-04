// Locale-owned panel copy.
//
// No product text is written inline in the panel's logic. Keeping every string here means adding a
// language is a new dictionary rather than a hunt through the code, and it makes the copy
// reviewable on its own — which matters because most of these strings exist to explain a refusal
// to someone who is confused about why the agent did nothing.

/** English copy. This is the reference dictionary; every other locale mirrors its keys. */
const en = {
  settings: "Settings",
  save: "Save",
  reconnect: "Reconnect",
  help: "Help",
  openDsh: "Open DeepSeek Harness",

  pairTitle: "Pair with your local connector",
  pairHint: "Run the installer, then type the pairing code it printed.",
  pairingCodeLabel: "Pairing code",
  pairAction: "Pair",
  pairingCodeInvalid: "That is not a complete pairing code. It is 20 letters and digits, usually shown in five groups.",

  settingsTitle: "Settings",
  brokerUrlLabel: "Connector address",
  brokerUrlHint: "Change this only if you changed the connector's port.",

  sessionsTitle: "DeepSeek Harness sessions",
  sessionsHint: "Choose the session that should control your tabs.",

  routeTitle: "What this session controls",
  chainSession: "DeepSeek session",
  chainBrowser: "Chrome profile",
  chainTabs: "Attached tabs",
  attachActive: "Attach this tab",
  chooseTabs: "Choose tabs",
  pickerHint: "Pick a tab to attach to this session.",
  attach: "Attach",
  detach: "Detach",
  makeActive: "Make active",
  activeBadge: "active",
  restrictedBadge: "not allowed",

  stateFirstRunTitle: "Welcome",
  stateFirstRunDetail: "Install the local connector, then pair this browser with the code it prints.",
  stateUnpairedTitle: "Not paired yet",
  stateUnpairedDetail: "Type the pairing code from the installer to connect this Chrome profile.",
  statePairingTitle: "Pairing",
  statePairingDetail: "Checking the code with the local connector.",
  stateConnectingTitle: "Connecting",
  stateConnectingDetail: "Reaching the local connector.",
  stateDisconnectedTitle: "Connector not reachable",
  stateDisconnectedDetail: "Nothing is listening at {url}. Start DeepSeek Harness, or run the installer again.",
  stateConnectedTitle: "Connected",
  stateConnectedDetail: "Paired with the local connector {version}.",
  stateNoSessionsTitle: "No DeepSeek Harness sessions",
  stateNoSessionsDetail: "Start a session in DeepSeek Harness and it will appear here.",
  stateNoSelectionTitle: "Choose a session",
  stateNoSelectionDetail: "Pick which DeepSeek Harness session may control your tabs.",
  stateNoTabsTitle: "No tabs attached",
  stateNoTabsDetail: "This session cannot see any page until you attach a tab. Nothing is shared before then.",
  stateReadyTitle: "Ready",
  stateReadyDetail: "{session} controls {count} tab(s) in this Chrome profile.",
  stateUpdateTitle: "Update required",
  stateUpdateDetail: "The extension and the local connector speak different protocol versions.",
  stateErrorTitle: "Something went wrong",

  noneYet: "Nothing here yet.",
  detachAll: "Detach session",
};

/** French copy. */
const fr = {
  settings: "Réglages",
  save: "Enregistrer",
  reconnect: "Reconnecter",
  help: "Aide",
  openDsh: "Ouvrir DeepSeek Harness",

  pairTitle: "Appairer le connecteur local",
  pairHint: "Lancez l'installateur, puis saisissez le code d'appairage affiché.",
  pairingCodeLabel: "Code d'appairage",
  pairAction: "Appairer",
  pairingCodeInvalid: "Ce code est incomplet. Il compte 20 lettres et chiffres, présentés en cinq groupes.",

  settingsTitle: "Réglages",
  brokerUrlLabel: "Adresse du connecteur",
  brokerUrlHint: "À modifier uniquement si vous avez changé le port du connecteur.",

  sessionsTitle: "Sessions DeepSeek Harness",
  sessionsHint: "Choisissez la session autorisée à piloter vos onglets.",

  routeTitle: "Ce que cette session contrôle",
  chainSession: "Session DeepSeek",
  chainBrowser: "Profil Chrome",
  chainTabs: "Onglets attachés",
  attachActive: "Attacher cet onglet",
  chooseTabs: "Choisir des onglets",
  pickerHint: "Choisissez un onglet à attacher à cette session.",
  attach: "Attacher",
  detach: "Détacher",
  makeActive: "Rendre actif",
  activeBadge: "actif",
  restrictedBadge: "non autorisé",

  stateFirstRunTitle: "Bienvenue",
  stateFirstRunDetail: "Installez le connecteur local, puis appairez ce navigateur avec le code affiché.",
  stateUnpairedTitle: "Pas encore appairé",
  stateUnpairedDetail: "Saisissez le code d'appairage de l'installateur pour connecter ce profil Chrome.",
  statePairingTitle: "Appairage",
  statePairingDetail: "Vérification du code auprès du connecteur local.",
  stateConnectingTitle: "Connexion",
  stateConnectingDetail: "Tentative de contact du connecteur local.",
  stateDisconnectedTitle: "Connecteur injoignable",
  stateDisconnectedDetail: "Rien n'écoute sur {url}. Démarrez DeepSeek Harness ou relancez l'installateur.",
  stateConnectedTitle: "Connecté",
  stateConnectedDetail: "Appairé avec le connecteur local {version}.",
  stateNoSessionsTitle: "Aucune session DeepSeek Harness",
  stateNoSessionsDetail: "Démarrez une session dans DeepSeek Harness et elle apparaîtra ici.",
  stateNoSelectionTitle: "Choisissez une session",
  stateNoSelectionDetail: "Indiquez quelle session DeepSeek Harness peut piloter vos onglets.",
  stateNoTabsTitle: "Aucun onglet attaché",
  stateNoTabsDetail: "Cette session ne voit aucune page tant que vous n'attachez pas d'onglet. Rien n'est partagé avant.",
  stateReadyTitle: "Prêt",
  stateReadyDetail: "{session} contrôle {count} onglet(s) dans ce profil Chrome.",
  stateUpdateTitle: "Mise à jour requise",
  stateUpdateDetail: "L'extension et le connecteur local ne parlent pas la même version de protocole.",
  stateErrorTitle: "Un problème est survenu",

  noneYet: "Rien pour l'instant.",
  detachAll: "Détacher la session",
};

/** Every dictionary, by locale prefix. */
const DICTIONARIES = { en, fr };

/**
 * The dictionary for the browser's language, falling back to English.
 *
 * Only the language prefix is used, so `fr-CA` and `fr-FR` share one dictionary rather than each
 * needing their own.
 * @param {string} [language] The UI language; defaults to the browser's.
 * @returns {Record<string, string>} The dictionary.
 */
export function dictionary(language = globalThis.navigator?.language ?? "en") {
  const prefix = String(language).toLowerCase().split("-")[0];
  return DICTIONARIES[prefix] ?? en;
}

/**
 * Look one key up and fill its placeholders.
 *
 * A missing key returns the key itself rather than an empty string: silent blank copy is far harder
 * to notice in review than a visible `stateReadyTitle`.
 * @param {Record<string, string>} dict The dictionary.
 * @param {string} key The message key.
 * @param {Record<string, string|number>} [values] Placeholder values.
 * @returns {string} The resolved copy.
 */
export function t(dict, key, values = {}) {
  const template = dict[key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : whole
  ));
}

/** The reference dictionary, exported so a test can prove every locale carries the same keys. */
export const REFERENCE_LOCALE = en;

/** Every locale this build ships. */
export const LOCALES = DICTIONARIES;
