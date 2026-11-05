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

  pairingCodeLabel: "Pairing code",
  pairAction: "Pair",
  pairingCodeInvalid: "That is not a complete pairing code. It is 20 letters and digits, usually shown in five groups.",

  brokerUrlLabel: "Connector address",
  brokerUrlHint: "Change this only if you changed the connector's port.",


  attachActive: "Attach this tab",
  attachShort: "Attach",
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
  stateDisconnectedTitle: "Connector not reachable",
  stateDisconnectedDetail: "Nothing is listening at {url}. Start DeepSeek Harness, or run the installer again.",
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
  stateUpdateFix: "Install the companion of this extension's version, then start DeepSeek Harness again: {command}",

  noneYet: "Nothing here yet.",

  onboardingTitle: "Set up in three steps",
  onboardingChecking: "Looking for the local connector at {url}…",
  onboardingDetected: "A connector is running at {url} on {os}. Type its pairing code below.",
  onboardingNotDetected: "No connector is listening at {url} on {os} yet. Install it, then start DeepSeek Harness.",
  onboardingOtherProgram: "Something other than the connector answers at {url}. Change the port in the DeepSeek Harness profile and in Settings here.",
  onboardingStepInstall: "Install the companion into your DeepSeek Harness profile, in a terminal on {os}:",
  onboardingStepStart: "Start DeepSeek Harness — for example dsh web. The connector starts its local broker by itself.",
  onboardingStepCode: "Print the pairing code, then type it below:",
  onboardingInstallerPosix: "Or run the one-file installer from the repository, install.sh, which does all of this and prints the code.",
  onboardingInstallerWindows: "Or double-click the one-file installer from the repository, Install Connector.cmd, which does all of this and prints the code.",
  onboardingCheck: "Check again",
  onboardingDocs: "Installation guide",
  copy: "Copy",
  copied: "Copied",
  osWindows: "Windows",
  osMac: "macOS",
  osLinux: "Linux",
  osOther: "this computer",

  headlineNotPaired: "Not paired",
  headlinePairing: "Pairing…",
  headlineUnreachable: "Connector unreachable",
  headlineConnected: "Connected · {count} session(s)",
  byline: "by Corsen AI · unofficial",
  footNotice: "Unofficial, by Corsen AI. Attached pages go to the model your DeepSeek Harness uses.",
  sessionSelectLabel: "DeepSeek Harness session",
  sessionPlaceholder: "Choose a session…",
  sessionNone: "No session yet",
  sessionOption: "{title} · {profile} · {count} tab(s)",
  refresh: "Refresh",
  tabsButton: "Tabs",
  pickerAttached: "This session's tabs",
  pickerOthers: "Attach another tab",
  aboutLabel: "What the connector can reach",
  aboutAccess: "Only the tabs you attach can be read or controlled, and only by the session you chose. Switching tabs in Chrome never moves a session to another tab.",
  aboutData: "Passwords, one-time codes and payment fields are masked inside the page before anything leaves it; a screenshot shows the page as you see it. Attached pages go through the local connector to your DeepSeek Harness, and from there to the model it uses.",
  aboutPublisher: "Unofficial community project by Corsen AI. No relay, no telemetry, no cookies.",
  routeTabs: "{count} tab(s)",
  cardReadyHint: "Ask the session to work in the attached tab. It acts there, and nowhere else.",
};

/** French copy. */
const fr = {
  settings: "Réglages",
  save: "Enregistrer",
  reconnect: "Reconnecter",
  help: "Aide",
  openDsh: "Ouvrir DeepSeek Harness",

  pairingCodeLabel: "Code d'appairage",
  pairAction: "Appairer",
  pairingCodeInvalid: "Ce code est incomplet. Il compte 20 lettres et chiffres, présentés en cinq groupes.",

  brokerUrlLabel: "Adresse du connecteur",
  brokerUrlHint: "À modifier uniquement si vous avez changé le port du connecteur.",


  attachActive: "Attacher cet onglet",
  attachShort: "Attacher",
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
  stateDisconnectedTitle: "Connecteur injoignable",
  stateDisconnectedDetail: "Rien n'écoute sur {url}. Démarrez DeepSeek Harness ou relancez l'installateur.",
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
  stateUpdateFix: "Installez le compagnon de la version de cette extension, puis redémarrez DeepSeek Harness : {command}",

  noneYet: "Rien pour l'instant.",

  onboardingTitle: "Installation en trois étapes",
  onboardingChecking: "Recherche du connecteur local sur {url}…",
  onboardingDetected: "Un connecteur tourne sur {url} ({os}). Saisissez son code d'appairage ci-dessous.",
  onboardingNotDetected: "Aucun connecteur n'écoute sur {url} ({os}) pour l'instant. Installez-le, puis démarrez DeepSeek Harness.",
  onboardingOtherProgram: "Un autre programme que le connecteur répond sur {url}. Changez le port dans le profil DeepSeek Harness et dans les réglages ici.",
  onboardingStepInstall: "Installez le compagnon dans votre profil DeepSeek Harness, dans un terminal ({os}) :",
  onboardingStepStart: "Démarrez DeepSeek Harness — par exemple dsh web. Le connecteur lance son broker local tout seul.",
  onboardingStepCode: "Affichez le code d'appairage, puis saisissez-le ci-dessous :",
  onboardingInstallerPosix: "Ou lancez l'installateur en un fichier du dépôt, install.sh, qui fait tout cela et affiche le code.",
  onboardingInstallerWindows: "Ou double-cliquez sur l'installateur en un fichier du dépôt, Install Connector.cmd, qui fait tout cela et affiche le code.",
  onboardingCheck: "Vérifier à nouveau",
  onboardingDocs: "Guide d'installation",
  copy: "Copier",
  copied: "Copié",
  osWindows: "Windows",
  osMac: "macOS",
  osLinux: "Linux",
  osOther: "cet ordinateur",

  headlineNotPaired: "Non appairé",
  headlinePairing: "Appairage…",
  headlineUnreachable: "Connecteur injoignable",
  headlineConnected: "Connecté · {count} session(s)",
  byline: "par Corsen AI · non officiel",
  footNotice: "Non officiel, par Corsen AI. Les pages attachées partent vers le modèle utilisé par votre DeepSeek Harness.",
  sessionSelectLabel: "Session DeepSeek Harness",
  sessionPlaceholder: "Choisir une session…",
  sessionNone: "Aucune session",
  sessionOption: "{title} · {profile} · {count} onglet(s)",
  refresh: "Actualiser",
  tabsButton: "Onglets",
  pickerAttached: "Onglets de cette session",
  pickerOthers: "Attacher un autre onglet",
  aboutLabel: "Ce que le connecteur peut atteindre",
  aboutAccess: "Seuls les onglets que vous attachez peuvent être lus ou pilotés, et seulement par la session choisie. Changer d'onglet dans Chrome ne déplace jamais une session.",
  aboutData: "Les mots de passe, codes à usage unique et champs de paiement sont masqués dans la page avant que quoi que ce soit n'en sorte ; une capture montre la page telle que vous la voyez. Les pages attachées passent par le connecteur local jusqu'à votre DeepSeek Harness, puis vers le modèle qu'il utilise.",
  aboutPublisher: "Projet communautaire non officiel de Corsen AI. Aucun relais, aucune télémétrie, aucun cookie.",
  routeTabs: "{count} onglet(s)",
  cardReadyHint: "Demandez à la session de travailler dans l'onglet attaché. Elle agit là, et nulle part ailleurs.",
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
