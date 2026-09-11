# Data disclosures

What the extension collects, where it goes, and what it does not do — in the terms the Chrome Web
Store data-use form asks for, and accurately.

## What the extension handles

### Page content from attached tabs

**What.** The visible text, title, URL, and a list of interactive controls of a tab **the user
explicitly attached** to a DeepSeek Harness session — but only when that session requests it.

**Where it goes.** From the tab, to the extension, to the local connector on `127.0.0.1`, to the
user's own locally running DeepSeek Harness. From there it goes wherever the user's DeepSeek Harness
is configured to send it — typically a model provider's API. **That is the user's DeepSeek Harness
doing that, under the user's configuration.** The extension adds no destination of its own.

**Before it leaves the page**, the following are masked and never transmitted:

- password fields;
- hidden form fields;
- one-time codes and fields the page declares as such;
- payment card numbers, security codes, expiry dates, and cardholder names, as declared by the page;
- fields whose name or label indicates a password, secret, token, API key, one-time code, card
  number, IBAN, SSN, or PIN;
- credential-bearing parameters in URLs, and any username or password embedded in a URL.

**Honest limitation.** Detection is by the signals a page gives. A field with no telling type,
attribute, name, or label cannot be distinguished from an ordinary one. We do not claim complete
secret detection.

### Screenshots of attached tabs

**What.** A picture of the visible part of a tab **the user explicitly attached**, taken only when
that tab's session requests one (`browser_screenshot`), as a JPEG of the viewport. Chrome can only
capture the tab at the front of its window, so a covered attached tab is brought to the front
first, and the result says that it was.

**Where it goes.** The same path as page content: to the local connector, to the user's own DeepSeek
Harness, which keeps a copy in its own attachment store on the user's computer and sends it to the
model provider the user configured — only if that model accepts images; for a text-only model
DeepSeek Harness substitutes a text placeholder that names the stored file.

**Honest limitation.** The masking above applies to text. **A screenshot is pixels, and nothing in
it is masked:** whatever the page shows on screen — a displayed code, an account number, a
message — is in the picture, exactly as the user sees it. (A password field's own dots are dots
in the picture too.) The tool's description tells the model to read pages with the text snapshot
and to use a screenshot for layout, and the user decides which tabs a session may see at all.

### Tab titles and URLs

**What.** The title and URL of open tabs, shown to the user in the panel so they can choose what to
attach; and of attached tabs, so the user always sees what a session controls.

**Where it goes.** To the panel. For attached tabs only, the current URL (scrubbed of credentials)
is also reported to the user's own DeepSeek Harness when it asks.

### Settings and identity

**What.** A random identifier for this installation, the connector's local address, the pairing
code the user typed, and which session is attached to which tabs.

**Where it goes.** Nowhere. Stored in this browser profile's extension storage. The pairing code is
used to compute a proof for the local connector and is never itself transmitted.

## What the extension does not do

- **Does not send anything to Corsen AI.** No analytics, telemetry, crash reports, usage
  statistics, or any other transmission. There is no Corsen server in the loop.
- **Does not read cookies.** The `cookies` permission is not requested.
- **Does not read history, bookmarks, passwords, or other extensions' data.**
- **Does not read page content from, or perform any action in, a tab the user has not attached.**
  When the user opens the tab chooser in the panel, the extension reads the titles and URLs of the
  open tabs locally, so the user can decide which tab to attach; that list stays in the panel and
  is not sent to DeepSeek Harness.
- **Does not act without a DeepSeek Harness request.** The extension is passive until a session the
  user attached asks for something.
- **Does not sell, share, or transfer data to third parties.** It has no third parties.
- **Does not use data for advertising, profiling, or creditworthiness.**
- **Does not persist page content.** Snapshots and screenshots are produced on request and
  forwarded; the extension keeps none. (The user's own DeepSeek Harness keeps screenshots in its
  attachment store, on the user's computer, as it keeps every image a tool gives it.)

## Chrome Web Store data-use form answers

| Question | Answer |
|---|---|
| Does the extension collect or use personal or sensitive user data? | Yes: website content (text, and screenshots on request) and web history (URLs) of tabs the user explicitly attaches, forwarded to the user's own local software. |
| Is it sold to third parties? | No. |
| Is it used for purposes unrelated to the single purpose? | No. |
| Is it used to determine creditworthiness or for lending? | No. |
| Is it transferred to third parties? | Not by the extension. The user's own DeepSeek Harness may send it to the model provider the user configured. |

## The one-paragraph version for the listing

> This extension lets your own locally running DeepSeek Harness read and act in the browser tabs you
> explicitly choose. Page content from those tabs — text, and a screenshot when the session asks
> for one — goes to your DeepSeek Harness on your computer, and from there to whatever model
> provider you configured it to use. Passwords, one-time codes, and payment fields are masked in
> the text before anything leaves the page; a screenshot shows the page as you see it. The
> extension never reads your
> cookies, never reads or acts in a tab you did not attach (it lists open tabs' titles and URLs only
> when you open the tab chooser, so you can pick one), and never sends anything to Corsen AI.
