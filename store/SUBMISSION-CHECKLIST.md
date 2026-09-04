# Chrome Web Store submission checklist

Everything the listing needs, and whether it exists. Submission is a **manual action requiring
explicit owner authorization** — this repository prepares it and does not perform it.

## Package

| Item | State | Where |
|---|---|---|
| Manifest V3, valid | done | `extension/manifest.json` |
| Version matches the companion package | done (0.1.0) | manifest, `companion/package.json` |
| No remote code, no `eval`, no interpreter | done | `src/` is plain ES modules |
| Icons 16 / 48 / 128 | done, generated | `extension/assets/`, `scripts/make-icons.mjs` |
| Production ZIP from a tagged clean tree | **open** | `scripts/package.mjs` not yet written |
| ZIP contains only allowlisted files | **open** | `scripts/verify-package.mjs` not yet written |
| ZIP byte-identical across two builds | **open** | gate AE |
| Packaged ZIP tested in Chromium, not the source tree | **open** | gate AD |

## Policy material

| Item | State | Where |
|---|---|---|
| Single purpose statement | done | `store/SINGLE-PURPOSE.md` |
| Permission justification per permission | done | `store/PERMISSION-JUSTIFICATIONS.md` |
| Data-use disclosures | done | `store/DATA-DISCLOSURES.md` |
| Privacy policy, hosted at a public URL | **open** | needs a page on the project site; content is in `DATA-DISCLOSURES.md` |
| Reviewer instructions | done | `store/REVIEWER-INSTRUCTIONS.md` |
| Review stand-in script | **open** | `scripts/review-session.mjs` referenced but not yet written |

## Listing

| Item | State | Notes |
|---|---|---|
| Title | done | `DeepSeek Harness Connector — by Corsen AI` (45 chars max: check) |
| Short description (132 chars max) | draft | "Let an exact DeepSeek Harness session operate the tabs you choose, in your own signed-in Chrome. Local, unofficial, by Corsen AI." |
| Detailed description | draft | Adapt `README.md` "What it does" and "What it never does" |
| Category | decide | Developer Tools or Productivity |
| Language | done | English; French UI shipped |
| Screenshots 1280×800 (at least one, up to five) | **open** | plan below |
| Small promo tile 440×280 | **open** | |
| Marquee promo tile 1400×560 | **open**, optional | |
| Support URL | **open** | GitHub issues |
| Homepage URL | done | GitHub repository |

## Screenshot plan

1. The panel in the **Ready** state: session → Chrome profile → attached tabs, with one real tab.
2. The **No tabs attached** state, showing the plain "nothing is shared" copy.
3. A snapshot as the model sees it, beside the page it came from, with a masked password field
   visible.
4. The **Update required** state, showing the actionable message.
5. The pairing screen.

Each screenshot is captured from the real extension by a script so it can be regenerated for every
release, not hand-made once.

## Before pressing submit

- [ ] All release-blocking gates in `docs/TEST-MATRIX.md` pass with evidence at the release tag.
- [ ] The npm package for the same version is published first, so a reviewer can install it.
- [ ] The privacy policy URL is live.
- [ ] The ZIP hash matches `release-manifest.json` in the GitHub release.
- [ ] Owner authorization recorded for this specific submission.

## Positioning

Open source, local-first, privacy-conscious, from a European publisher. An unofficial community
project. **Do not claim** official DeepSeek status, endorsement, regulatory certification, AI Act or
NIS2 compliance, or any security guarantee not proven in `docs/TEST-EVIDENCE.md`.
