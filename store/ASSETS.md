# Chrome Web Store asset provenance

Every image in this directory is produced by `scripts/capture-screenshots.ts` from the real
extension, so the set is regenerated for each release rather than hand-made once. None is drawn by
hand, composited from mock-ups, or backed by prewritten content.

## How a screenshot is made

Chrome for Testing loads the unpacked extension through the same harness the end-to-end suites use
(`tests/e2e/harness.ts`), with a real in-process broker and a real agent client standing in for a
DeepSeek Harness session named "Research notes". The script drives the extension into each named
panel state and captures two things Chrome rendered: the attached page at 899×800 and the
extension's own panel page (`src/sidepanel.html`) at 380×800. The two captures are placed side by
side on a 1280×800 canvas the way Chrome's side panel sits beside a page, with a one-pixel divider
in the panel's border colour. The composition is done in `scripts/png.mjs`, a PNG codec of this
repository, from the two captures' pixels and nothing else.

The page is `tests/fixtures/page-demo.html` — "Northwind Notes", invented, non-sensitive content —
served by the harness's loopback fixture server under the name `northwind.localhost`, which
Chrome resolves to loopback itself. The port in its address is whatever the server was given for
that run, so two runs differ in that number and nothing else the eye can see.

Screenshot 4 shows, beside the page, the actual `browser_snapshot` result the agent client received
for it, rendered as JSON in a page styled with the panel's palette. The script refuses to write it
if the password field's real value appears anywhere in that result.

## How the promotional tiles are made

HTML and SVG rendered by the same Chrome at the Store's exact sizes, in the style of Corsen's
Hermes Connector and by the Store's rules for promotional images (developer.chrome.com, "Supplying
images": mostly brand, avoid text, legible at half size, the whole area filled, well-defined
edges). The Corsen AI mark glows on black (`store/brand/corsen-mark.png`, Corsen's own artwork, the
one bitmap involved) beside the product name; the marquee adds "by Corsen AI" and one session
fanning out to four tab windows. Every element sits on one horizontal axis inside margins of 12 to
13 % of the height, and the name is shrunk until it fits its column. No third-party marks (no
DeepSeek logo), no people, no fake interface.

## The icons

Since 2026-11-05 the extension carries the Corsen AI mark as its icon, the same files Hermes
Connector v0.2.6 ships (`extension/assets/icon-{16,48,128}.png`, from that repository's
`extension/assets/`), so Corsen's two connectors share one identity; the package's `icon.png` is
the 128-pixel one. `store-icon-128.png` is the Store icon Hermes Connector uses, the mark with
"Corsen AI" beneath it. The earlier generated "⊢" glyph and its script are gone.

## Reproduce

```bash
npm ci && npm ci --prefix companion && npx playwright install chromium
node --experimental-strip-types scripts/capture-screenshots.ts --out store/screenshots
mv store/screenshots/promo-*.png store/
```

(Headed, under a display or `xvfb-run`; `DSH_E2E_HEADLESS=1` on a machine without one.)

## Files, as committed on 2026-11-05 at the commit `git log -1 -- store/screenshots` names

Recaptured on 2026-11-05 at the release-tarball commit: the setup card (screenshot 1) and the
"Update required" state (screenshot 5) now show the `dsh plugin add` of the companion's release URL
(ADR 0011). The panel was redrawn on 2026-11-05 in the layout Corsen's Hermes Connector uses: one status
strip, one compact strip with the session and the tab it acts in, popovers for the tabs, the
access notes and the settings, and a single card for the next step. Screenshots 1, 2, 3 and 5 show
it; screenshot 4, the composed view of what a session receives, differs from 2026-09-12 only in the
fixture server's port. The promotional tiles were redrawn on 2026-11-05 in the Corsen style, with the Corsen icons.

| File | Size | Bytes | SHA-256 |
|---|---|---|---|
| `screenshots/01-pair.png` | 1280×800 | 124057 | `560f93b09392981f4ef161fb42bb38b7abf0ff5efc78d197787d8ed5617a8f1c` |
| `screenshots/02-no-tabs.png` | 1280×800 | 105175 | `269570f17fee42892f2ac303785e7e84b713a2e2666241f8b9ae38233ed3236e` |
| `screenshots/03-ready.png` | 1280×800 | 104748 | `7584c58ca4833f5cc12d5187688e9965b07f090e799c952ee2211b7f3ee9cf1c` |
| `screenshots/04-snapshot.png` | 1280×800 | 96048 | `80ab7eb87f0e29a3fc164fe5e0859d4bdcc70b1fb205314841039d86031e8e3b` |
| `screenshots/05-update-required.png` | 1280×800 | 110448 | `1f90adb7b175ad00c27aa4624f30b2c4829823b83af10ee8974c7966c3ba3b28` |
| `promo-small-440x280.png` | 440×280 | 120892 | `7edca4fa82afbc93a644199798608b26a7209f8d3b8f4823b11f3774a383f8bf` |
| `promo-marquee-1400x560.png` | 1400×560 | 542431 | `1f3079a3c83d750819536fca5ce5c5e799b907feace3383dd258e165c477ecb1` |
| `../extension/assets/icon-128.png` (the extension's icon) | 128×128 | 8327 | `6650826310ccf7703d0f97fa95b0d46f5572037f9407c3d78d96f2473d7e994e` |
| `store-icon-128.png` (Store icon) | 128×128 | 15492 | `50d498c65573e7fa74b638858dd300f685d5bfdbd20ad346a807a2d2cc14ebbf` |
| `brand/corsen-mark.png` (source of the tiles) | 344×373 | 146349 | `dc328f34079643ad2ff76ebd98aeab5299ac9d20dc6305ffd7b953164a191854` |

Environment of that capture: Ubuntu 26.04.1, Chrome for Testing 153.0.8010.12 (Playwright 1.63.0),
Node v26.8.1, headed on the virtual display (`xvfb-run`, with the browser asking for X11 since `5cbfba6`;
before that commit a run through `xvfb-run` on this Wayland desktop drew on the desktop itself). The
screenshots are stored as 24-bit RGB without an alpha channel, which the Store requires ("PNG 24 bits, sans alpha"; re-encoded pixel for pixel from the opaque captures, the tiles were RGB already). The
capture is deterministic on that display: a second run gives the same bytes for every file but the
two whose fixture page shows the connector's random port.
