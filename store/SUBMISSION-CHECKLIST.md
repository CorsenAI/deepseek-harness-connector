# Chrome Web Store submission checklist

Everything the listing needs, and whether it exists. Submission is a **manual action requiring
explicit owner authorization** — this repository prepares it and does not perform it.

## Package

| Item | State | Where |
|---|---|---|
| Manifest V3, valid | done | `extension/manifest.json` |
| Version matches the companion package | done (0.1.0) | manifest, `companion/package.json`, checked by `scripts/verify-package.mjs` |
| No remote code, no `eval`, no interpreter | done | `src/` is plain ES modules; the verifier scans for foreign hosts |
| Permission set frozen and enforced | done | ADR 0009; the verifier refuses any other set or any optional permission |
| Production ZIP from a clean tree | done | `scripts/package.mjs`, which refuses a dirty tree |
| ZIP contains only allowlisted files | done | `scripts/verify-package.mjs` |
| ZIP byte-identical across builds and platforms | done | identical hashes from Linux, macOS and Windows builds of the same commit (`docs/TEST-EVIDENCE.md`, 2026-09-11) |
| Packaged ZIP tested in Chromium, not the source tree | done | gates AD and AQ |

## Policy material

| Item | State | Where |
|---|---|---|
| Single purpose statement | done | `store/SINGLE-PURPOSE.md` |
| Permission justification per permission | done | `store/PERMISSION-JUSTIFICATIONS.md` |
| Data-use disclosures | done | `store/DATA-DISCLOSURES.md` |
| Privacy policy page | done, **live** | `https://corsen.ai/privacy/deepseek-harness-connector/` (2026-11-05, same template and place as Hermes Connector's; linked from `https://corsen.ai/privacy/`); the same text is `docs/privacy/index.html`, byte-identical to `store/privacy.html` (checked by the verifier), which GitHub Pages will also serve once the owner enables it from `/docs` on `main` |
| Reviewer instructions | done | `store/REVIEWER-INSTRUCTIONS.md` |
| Review stand-in script | done | `scripts/review-session.mjs` |

## Listing

| Item | State | Where |
|---|---|---|
| Title (45 max) | done, 41 characters | `store/LISTING.md` |
| Short description (132 max) | done, 129 characters | `store/LISTING.md` |
| Detailed description | done, EN and FR | `store/LISTING.md` |
| Category | Developer Tools | `store/LISTING.md` |
| Language | English; French panel copy shipped | `extension/src/i18n.js` |
| Screenshots 1280×800, five | done, captured by script from the real extension | `store/screenshots/`, provenance in `store/ASSETS.md` |
| Small promo tile 440×280 | done | `store/promo-small-440x280.png` |
| Marquee promo tile 1400×560 (optional) | done | `store/promo-marquee-1400x560.png` |
| Store icon 128×128 | done | `extension/assets/icon-128.png` |
| Support URL | `https://corsenai.github.io/deepseek-harness-connector/support/` (and GitHub issues) | needs the remote and Pages |
| Homepage URL | `https://corsenai.github.io/deepseek-harness-connector/` | needs the remote and Pages |
| Companion tarball URL | `https://github.com/CorsenAI/deepseek-harness-connector/releases/download/v0.1.0/corsen-ai-dsh-browser-connector-0.1.0.tgz` — what the setup card and the installers name (ADR 0011) | needs the GitHub release `v0.1.0` with the tarball attached, **public before submission**: a reviewer who follows the card must be able to install |

## Before pressing submit

- [ ] All release-blocking gates in `docs/TEST-MATRIX.md` pass with evidence at the release tag.
- [ ] The GitHub remote exists, CI has run green on it, and the privacy page is live at a public URL.
- [ ] The npm package for the same version is published first, so a reviewer can install it.
- [ ] The ZIP hash matches `release-manifest.json` in the GitHub release.
- [ ] Owner authorization recorded for this specific submission.

## Positioning

Open source, local-first, privacy-conscious, from a European publisher. An unofficial community
project. **Do not claim** official DeepSeek status, endorsement, regulatory certification, AI Act or
NIS2 compliance, or any security guarantee not proven in `docs/TEST-EVIDENCE.md`.
