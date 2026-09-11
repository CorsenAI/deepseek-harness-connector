# Single purpose

Chrome Web Store policy requires an extension to have a single, narrow, easy-to-understand purpose.
This is ours, stated once, and every permission and feature maps back to it.

## The purpose

**Connect explicitly user-selected browser tabs to the user's locally running DeepSeek Harness
sessions, so those sessions can perform requested browser actions in those tabs.**

## What that means in practice

The user runs DeepSeek Harness on their own computer. This extension lets them pick one of its
sessions and attach one or more of their open tabs to it. That session — and only that session —
can then read those tabs as structured text or as a screenshot, and click, type, and navigate in
them. Nothing else is in scope.

## What is deliberately outside the purpose

- **A chat interface.** DeepSeek Harness has its own. The extension's panel shows routing and status
  only.
- **Network capture, request interception, or traffic inspection.** A different privacy surface
  and not part of connecting tabs to sessions.
- **Reading cookies, history, bookmarks, or passwords.** Logins are preserved by operating the page
  the user already has open, not by taking their credentials.
- **Reading page content from, or acting in, tabs the user did not attach.** Ever. The only thing
  the extension learns about an unattached tab is its title and URL, read locally when the user
  opens the tab chooser so they can pick one, and never sent to DeepSeek Harness.
- **Any communication with Corsen AI's servers.** There are none. The extension talks only to the
  connector on `127.0.0.1`.
- **Automation of the browser without a DeepSeek Harness session.** The extension does nothing on
  its own initiative.

## How the purpose is enforced, not merely stated

- The extension has no tool a model could call that attaches a tab, changes a setting, or moves
  ownership. Those actions exist only in the panel, driven by the user.
- A session with no attached tab receives a refusal. There is no fallback to the active tab.
- The twenty-one capabilities the extension implements — reading a tab as text or as a
  screenshot, finding text, clicking, typing, pressing keys, scrolling, hovering, choosing options,
  dragging, navigating, and opening, listing, switching and closing the session's own tabs — are
  the complete list, declared in its handshake, and the local connector refuses anything else.
