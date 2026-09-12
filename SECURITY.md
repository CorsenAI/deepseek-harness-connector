# Security policy

DeepSeek Harness Connector lets a DeepSeek Harness session act in a signed-in browser. Its
security model — what is protected, how, and what is deliberately not — is in
[`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md); the threats and the tests that answer each are
in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Reporting a vulnerability

Open a **private security advisory** on this repository (Security → Report a vulnerability) rather
than a public issue, or write to <hello@corsen.ai>. Please never include a pairing code, a page's
content, or anything from a signed-in site in a report; a description and steps are enough.

A report is answered within five working days. A defect in routing (one session reaching another
session's tab, or any tab the user did not attach), in redaction (a password, one-time code,
payment field or hidden value leaving the page as text), or in pairing (the shared secret reachable
by a page or a model) is treated as a release blocker: it is fixed and released before anything
else ships, and credited in the release notes if the reporter wishes.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (extension and `@corsen-ai/dsh-browser-connector` together) | yes |

The extension and the companion must be the same version; a mismatch is refused at the handshake
and shown as "Update required", never worked around.

## What is out of scope

- Another extension in the same Chrome profile reading the same pages: Chrome's extension isolation
  is the boundary there.
- What the user's own DeepSeek Harness does with page content once it has it: the connector adds
  no destination and removes none.
- Sites that ignore synthetic input events: reported as a failed action, never hidden.

Unofficial community project by Corsen AI. Not affiliated with, endorsed by, or certified by
DeepSeek.
