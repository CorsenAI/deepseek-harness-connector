# Permission justifications

One entry per permission in `extension/manifest.json`, in the words we will give the Chrome Web
Store review form. Each maps directly to the single purpose in `SINGLE-PURPOSE.md`.

## `storage`

Stores this installation's random identity, the user's connector address and pairing code, and
which of the user's DeepSeek Harness sessions is attached to which tabs. All of it is local to this
browser profile. Nothing in storage is page content.

## `sidePanel`

The side panel is the extension's only user interface. It is where the user pairs with their local
connector, chooses a DeepSeek Harness session, and attaches or detaches tabs. Without it the user
could not select anything, and the single purpose requires explicit selection.

## `scripting`

Used to run the page-reading and page-acting code inside a tab **the user explicitly attached**, and
only when that tab's DeepSeek Harness session requests an action. The injected code produces a
structured text snapshot, or performs one click or one typing action, and returns. It is never
injected into a tab that is not attached.

## `alarms`

Chrome terminates the extension's service worker when idle. A periodic alarm lets it wake and
restore the connection to the local connector, so that a DeepSeek Harness session's request is not
lost simply because the worker had been evicted. The alarm does nothing when already connected.

## Host permission: `<all_urls>`

The core gesture of the product is "attach the tab I am looking at", and the user may be looking at
any site. The extension must be able to run its page code in whichever tab the user chooses.

We evaluated optional per-origin host permissions and rejected them for this version: every first
attachment on a new site would raise a permission prompt, and a session that follows a link to
another origin would lose its own attached tab mid-task until the user answered a second prompt.
That turns the central interaction into a prompt sequence and makes a deliberate refusal
indistinguishable from a missing grant.

**The effective access is narrower than the grant, and the extension enforces it:** page code runs
only in a tab the user explicitly attached, only for the session that owns it, only when that
session requests an action. No page code runs in, and no page content is read from, a tab the user
has not attached. The only thing the extension learns about other tabs is their title and URL, read
locally when the user opens the tab chooser so they can pick one, and never sent to DeepSeek
Harness. This is stated here plainly rather than hidden.

## Permissions deliberately not requested

| Permission | Why not |
|---|---|
| `tabs` | Not needed. With the host permission above, Chrome already exposes the title and URL of any page the extension may act in; `tabs` would only add them for pages it may not act in, and would add a "Read your browsing history" warning. Verified by removing it and re-running the complete real-browser suite (41/41). A tab whose address Chrome withholds is treated as restricted and cannot be attached. See ADR 0006, amendment. |
| `cookies` | Not needed. Logins are preserved by operating the signed-in page, not by reading credentials. Not requesting it is what makes that claim checkable. |
| `debugger` | Not needed for the click, type, and read capabilities this version ships, and it would show a permanent debugging banner on every attached tab plus an alarming install warning. See ADR 0006. |
| `webRequest`, `declarativeNetRequest` | Network capture is outside the single purpose. |
| `nativeMessaging` | The connector is reached over a local WebSocket; no native host is installed by the extension. |
| `history`, `bookmarks`, `downloads`, `clipboardRead` | Outside the single purpose. |

## Remote code

None. Every line of browser-control logic ships in the Store package. The extension loads no
external script, evaluates no downloaded code, and contains no interpreter. Its only network
destination is the user's own `127.0.0.1`.
