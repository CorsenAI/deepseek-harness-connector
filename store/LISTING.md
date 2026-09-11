# Chrome Web Store listing

The text pasted into the developer dashboard, in both shipped languages. Limits are the Store's:
title 45 characters, short description 132 characters. Every claim below is one the repository
proves (`docs/TEST-EVIDENCE.md`); nothing here says "official", "certified", or "secure" as a bare
adjective.

## English (default)

**Title** (41 characters)

```
DeepSeek Harness Connector — by Corsen AI
```

**Short description** (129 characters)

```
Let an exact DeepSeek Harness session operate the tabs you choose, in your own signed-in Chrome. Local, unofficial, by Corsen AI.
```

**Detailed description**

```
DeepSeek Harness Connector lets one exact DeepSeek Harness session — running on your own computer — read and act in the browser tabs you explicitly attach to it, inside the Chrome profile you are already signed in to. No hidden automation browser, no guessing which tab belongs to which task.

HOW IT WORKS
1. Install the companion into a DeepSeek Harness profile: dsh plugin --profile web add @corsen-ai/dsh-browser-connector
2. Start the local connector and read the pairing code it prints.
3. Type that code once into this extension's side panel.
4. Pick a session, open the tab you want it to work in, and press "Attach this tab".

The panel always shows the route in plain words: DeepSeek session → Chrome profile → attached tabs. If an action cannot run, the panel says why — not paired, no session selected, no tab attached, connector unreachable, versions mismatched.

WHAT A SESSION CAN DO IN ITS TABS
Read the visible page as structured text, take a screenshot of it, find text, click, type, press keys, scroll, hover, choose options, drag, navigate, go back and forward, reload, and open, list, switch, and close tabs — only within the tabs you attached to that session.

WHAT IT NEVER DOES
• Never reads or acts in a tab you did not attach. Attachment is explicit and per session.
• Never reads your cookies, history, bookmarks, or saved passwords — those permissions are not requested.
• Passwords, one-time codes, payment fields, and hidden values are masked inside the page, before anything leaves the browser. A screenshot, taken only when the session asks for one, shows the page as you see it: pixels are not masked.
• Never sends anything to Corsen AI. The extension talks only to the connector on your computer (127.0.0.1); page content goes from there to your own DeepSeek Harness, and onward only to the model provider you configured it with.
• Never claims an action happened when the browser refused it. A closed tab, an invalid form, a page that navigated away — each is reported for what it was.

EXACT ROUTING
Every browser action carries the identity of the session that asked for it and reaches one bound tab. Two sessions, two projects, or two Chrome profiles running at the same time never act in each other's tabs. A session with no attached tab gets a refusal, never someone else's page.

OPEN SOURCE
The extension, the companion, and every test that proves the claims above are published at https://github.com/CorsenAI/deepseek-harness-connector under the MIT licence.

Unofficial community project by Corsen AI. Not affiliated with, endorsed by, or certified by DeepSeek. Requires DeepSeek Harness (dsh) installed on your computer, Node.js 22.19 or newer, and pnpm.
```

**Category:** Developer Tools
**Language:** English (the panel also ships French)
**Homepage:** https://github.com/CorsenAI/deepseek-harness-connector
**Support:** https://github.com/CorsenAI/deepseek-harness-connector/issues
**Privacy policy:** `https://corsenai.github.io/deepseek-harness-connector/privacy/` — `docs/privacy/index.html`, byte-identical to `store/privacy.html` (the verifier checks), live once GitHub Pages is enabled from `/docs` on `main`

## Français

**Titre** (39 caractères)

```
Connecteur DeepSeek Harness — Corsen AI
```

**Description courte** (128 caractères)

```
Une session DeepSeek Harness précise agit dans les onglets que vous choisissez, dans votre Chrome connecté. Local, non officiel.
```

**Description détaillée**

```
Le Connecteur DeepSeek Harness permet à une session DeepSeek Harness précise — qui tourne sur votre propre ordinateur — de lire et d'agir dans les onglets que vous lui attachez explicitement, dans le profil Chrome où vous êtes déjà connecté. Pas de navigateur d'automatisation caché, pas de devinette sur l'onglet qui appartient à quelle tâche.

COMMENT ÇA MARCHE
1. Installez le compagnon dans un profil DeepSeek Harness : dsh plugin --profile web add @corsen-ai/dsh-browser-connector
2. Lancez le connecteur local et lisez le code d'appairage qu'il affiche.
3. Saisissez ce code une seule fois dans le panneau latéral de cette extension.
4. Choisissez une session, ouvrez l'onglet où elle doit travailler, puis appuyez sur « Attacher cet onglet ».

Le panneau montre toujours le chemin en toutes lettres : session DeepSeek → profil Chrome → onglets attachés. Si une action ne peut pas s'exécuter, le panneau dit pourquoi — non appairé, aucune session choisie, aucun onglet attaché, connecteur injoignable, versions incompatibles.

CE QU'UNE SESSION PEUT FAIRE DANS SES ONGLETS
Lire la page visible sous forme de texte structuré, en prendre une capture d'écran, chercher du texte, cliquer, saisir, appuyer sur des touches, faire défiler, survoler, choisir des options, glisser-déposer, naviguer, revenir en arrière et en avant, recharger, et ouvrir, lister, changer et fermer des onglets — uniquement parmi les onglets que vous avez attachés à cette session.

CE QU'ELLE NE FAIT JAMAIS
• Ne lit ni n'agit jamais dans un onglet que vous n'avez pas attaché. L'attachement est explicite et par session.
• Ne lit jamais vos cookies, votre historique, vos favoris ni vos mots de passe enregistrés — ces permissions ne sont pas demandées.
• Les mots de passe, codes à usage unique, champs de paiement et valeurs cachées sont masqués dans la page, avant que quoi que ce soit ne quitte le navigateur. Une capture d'écran, prise uniquement quand la session la demande, montre la page telle que vous la voyez : les pixels ne sont pas masqués.
• N'envoie jamais rien à Corsen AI. L'extension ne parle qu'au connecteur sur votre ordinateur (127.0.0.1) ; le contenu des pages va de là à votre propre DeepSeek Harness, puis uniquement au fournisseur de modèle que vous y avez configuré.
• Ne prétend jamais qu'une action a eu lieu quand le navigateur l'a refusée. Un onglet fermé, un formulaire invalide, une page qui a navigué ailleurs — chaque cas est rapporté pour ce qu'il est.

ROUTAGE EXACT
Chaque action de navigateur porte l'identité de la session qui l'a demandée et atteint un seul onglet lié. Deux sessions, deux projets ou deux profils Chrome ouverts en même temps n'agissent jamais dans les onglets l'un de l'autre. Une session sans onglet attaché reçoit un refus, jamais la page de quelqu'un d'autre.

CODE OUVERT
L'extension, le compagnon et chaque test qui prouve les affirmations ci-dessus sont publiés sur https://github.com/CorsenAI/deepseek-harness-connector sous licence MIT.

Projet communautaire non officiel de Corsen AI. Sans affiliation, approbation ni certification de DeepSeek. Nécessite DeepSeek Harness (dsh) installé sur votre ordinateur, Node.js 22.19 ou plus récent, et pnpm.
```

## Screenshots, in the order they are uploaded

| # | File | Caption (EN) | Caption (FR) |
|---|---|---|---|
| 1 | `screenshots/01-pair.png` | Pair once with the code your local connector prints. | Appairez une fois avec le code affiché par votre connecteur local. |
| 2 | `screenshots/02-no-tabs.png` | Pick the DeepSeek Harness session; nothing is shared until you attach a tab. | Choisissez la session DeepSeek Harness ; rien n'est partagé tant que vous n'attachez pas d'onglet. |
| 3 | `screenshots/03-ready.png` | The route in plain words: session → Chrome profile → attached tabs. | Le chemin en toutes lettres : session → profil Chrome → onglets attachés. |
| 4 | `screenshots/04-snapshot.png` | What the session receives — the password is masked before it leaves the page. | Ce que la session reçoit — le mot de passe est masqué avant de quitter la page. |
| 5 | `screenshots/05-update-required.png` | A version mismatch is a clear message, never undefined behaviour. | Une incompatibilité de versions est un message clair, jamais un comportement indéfini. |

Promotional images: `promo-small-440x280.png` (required), `promo-marquee-1400x560.png` (optional).
Store icon: `../extension/assets/icon-128.png`, the icon the extension ships. Provenance and hashes:
`ASSETS.md`.
