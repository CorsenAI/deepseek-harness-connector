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

## `tabs`

Needed to show the user which tabs are open so they can attach one; to display the title and URL
of tabs already attached, so the user always sees what a session controls; to detect when an
attached tab is closed so the session loses it; and to verify after a browser restart that a stored
tab still exists before acting on it. Tab titles and URLs are shown to the user in the panel and
reported to the user's own local DeepSeek Harness for the attached tabs only.

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
session requests an action. Unattached tabs are never touched. This is stated here plainly rather
than hidden.

## Permissions deliberately not requested

| Permission | Why not |
|---|---|
| `cookies` | Not needed. Logins are preserved by operating the signed-in page, not by reading credentials. Not requesting it is what makes that claim checkable. |
| `debugger` | Not needed for the click, type, and read capabilities this version ships, and it would show a permanent debugging banner on every attached tab plus an alarming install warning. See ADR 0006. |
| `webRequest`, `declarativeNetRequest` | Network capture is outside the single purpose. |
| `nativeMessaging` | The connector is reached over a local WebSocket; no native host is installed by the extension. |
| `history`, `bookmarks`, `downloads`, `clipboardRead` | Outside the single purpose. |

## Remote code

None. Every line of browser-control logic ships in the Store package. The extension loads no
external script, evaluates no downloaded code, and contains no interpreter. Its only network
destination is the user's own `127.0.0.1`.
