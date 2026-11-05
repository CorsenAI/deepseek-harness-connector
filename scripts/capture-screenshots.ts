/**
 * Capture the Chrome Web Store screenshots and promotional tiles from the real extension.
 *
 * Every image is produced by Chrome rendering the shipped extension in a named state, driven by
 * the same harness the end-to-end suites use, so the set can be regenerated for every release
 * rather than hand-made once. A screenshot is a side-by-side composition of two real captures —
 * the attached page as Chrome rendered it and the extension's panel page as Chrome rendered it —
 * laid out the way the side panel sits beside a page; nothing in it is drawn by hand. The
 * promotional tiles are rendered from HTML with the extension's own palette and mark.
 *
 * The demo page is `tests/fixtures/page-demo.html`, whose content is invented and non-sensitive.
 *
 * Run: `node --experimental-strip-types scripts/capture-screenshots.ts [--out store/screenshots]`
 * (headed under a display or Xvfb; `DSH_E2E_HEADLESS=1` for a machine without one). Prints a
 * SHA-256 per file for `store/ASSETS.md`.
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { AgentClient } from '../companion/src/agent-client.ts'
import { ACTION } from '../companion/src/protocol.ts'
import { canvas, decodePng, encodePng, paste } from './png.mjs'
import { attachTab, pairExtension, settle, startHarness, tabIdFor, waitFor, type Harness } from '../tests/e2e/harness.ts'

const WIDTH = 1280
const HEIGHT = 800
const PANEL_WIDTH = 380
const DIVIDER = [36, 42, 54] as [number, number, number]
const PROFILE = 'web.shots0000001'
const SESSION = 'research-notes'

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex >= 0 ? String(process.argv[outIndex + 1]) : join('store', 'screenshots')
mkdirSync(outDir, { recursive: true })

const harness: Harness = await startHarness()
const written: { file: string, sha256: string, bytes: number }[] = []

/**
 * Write one PNG and record its hash.
 * @param name - the file name.
 * @param png - the bytes.
 */
function save(name: string, png: Buffer): void {
  const file = join(outDir, name)
  writeFileSync(file, png)
  written.push({ file, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length })
  process.stdout.write(`wrote ${file} (${png.length} bytes)\n`)
}

/**
 * Compose a page capture and a panel capture into one 1280×800 screenshot.
 * @param pageShot - the page as Chrome rendered it, 900×800.
 * @param panelShot - the panel page as Chrome rendered it, 380×800.
 * @returns the PNG.
 */
function compose(pageShot: Buffer, panelShot: Buffer): Buffer {
  const image = canvas(WIDTH, HEIGHT, DIVIDER)
  paste(image, decodePng(pageShot), 0, 0)
  paste(image, decodePng(panelShot), WIDTH - PANEL_WIDTH, 0)
  return encodePng(WIDTH, HEIGHT, image.pixels)
}

/** The panel page, sized as Chrome's side panel shows it. */
const panel = harness.panel
await panel.setViewportSize({ width: PANEL_WIDTH, height: HEIGHT })

/**
 * The demo page, sized to fill the rest of the frame. Chrome resolves any `.localhost` name to
 * loopback itself, so the fixture server can be reached under a readable host name.
 */
const demoUrl = harness.pageUrl('page-demo.html').replace('127.0.0.1', 'northwind.localhost')
const demo: Page = await harness.context.newPage()
await demo.setViewportSize({ width: WIDTH - PANEL_WIDTH - 1, height: HEIGHT })
await demo.goto(demoUrl)
await settle(300)

/** Capture the current pair. */
async function shot(name: string): Promise<void> {
  await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'connector/changed' }).catch(() => {}) })
  await settle(400)
  const pageShot = await demo.screenshot({ type: 'png' })
  const panelShot = await panel.screenshot({ type: 'png' })
  save(name, compose(pageShot, panelShot))
}

// 1. First run: the setup card and the pairing form, before any code was typed. The connector
// address is set to the running broker so the card shows the state a user reaches after
// installing the companion: detected, waiting for its code.
await panel.evaluate(async (url: string) => {
  await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl: url, pairingCode: '' } })
}, `ws://127.0.0.1:${harness.broker.port}`)
await panel.reload()
await waitFor('the setup card to detect the broker', async () => await panel.evaluate(() => document.getElementById('onboarding')?.dataset['probe'] === 'running'))
await settle(400)
await shot('01-pair.png')

// 2. Paired, a session announced, selected, no tab attached yet.
await pairExtension(harness)
const agent = new AgentClient({ url: `ws://127.0.0.1:${harness.broker.port}`, secret: harness.secret, version: '0.1.0', profileId: PROFILE, name: 'DeepSeek Harness (web)' })
agent.start()
await waitFor('the agent to pair', () => agent.connected)
agent.addSession(SESSION, 'Research notes')
await settle(300)
await panel.evaluate(async ([profileId, sessionId]: string[]) => {
  await chrome.runtime.sendMessage({ type: 'connector/select-scope', profileId, sessionId })
}, [PROFILE, SESSION])
await panel.reload()
await settle(400)
await shot('02-no-tabs.png')

// 3. Ready: the demo tab attached to the session; the route is shown.
const tabId = await tabIdFor(harness, demoUrl)
const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
if (!attached.ok) throw new Error(attached.error ?? 'attach failed')
await panel.reload()
await settle(500)
await shot('03-ready.png')

// 4. What DeepSeek Harness receives: a real snapshot of the attached page, rendered beside it. The
//    password field's value is masked before it ever left the page.
const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { url: string, title: string, text: string, elements: Record<string, unknown>[] }
const passwordField = snapshot.elements.find((element) => String(element['name']).toLowerCase().includes('password'))
if (!passwordField) throw new Error('the demo page must expose a password field')
if (String(passwordField['value'] ?? '').includes('correct-horse')) throw new Error('the password reached the snapshot; the screenshot must not be taken')
const shown = {
  url: snapshot.url,
  title: snapshot.title,
  text: `${snapshot.text.slice(0, 260)}…`,
  elements: snapshot.elements.slice(0, 9),
}
const viewer = await harness.context.newPage()
await viewer.setViewportSize({ width: PANEL_WIDTH, height: HEIGHT })
await viewer.setContent(`<!doctype html><meta charset="utf-8"><title>What DeepSeek Harness receives</title>
<style>
  body { margin: 0; padding: 16px 14px; background: #0e1016; color: #e7ebf3; font: 12px/1.5 Inter, "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 13px; margin: 0 0 4px; } p { margin: 0 0 10px; color: #98a2b6; font-size: 11px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace; color: #cfd6e4; background: #161a23; border: 1px solid #242a36; border-radius: 10px; padding: 12px; }
  .mask { color: #58a6ff; font-weight: 600; }
</style>
<h1>What the DeepSeek Harness session receives</h1>
<p>browser_snapshot on the attached tab — the password is masked in the page, before it leaves the browser.</p>
<pre>${JSON.stringify(shown, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"(\[masked[^"]*\]|•+)"/g, '<span class="mask">"$1"</span>')}</pre>`)
await settle(300)
save('04-snapshot.png', compose(await demo.screenshot({ type: 'png' }), await viewer.screenshot({ type: 'png' })))
await viewer.close()

// 5. Update required: the state the panel shows when the extension and the connector no longer
//    speak the same protocol, with the actionable message.
await panel.evaluate(async () => {
  await chrome.storage.local.set({ updateNotice: { required: true, reason: 'The local connector speaks protocol 2; this extension speaks protocol 1. Update the extension from the Chrome Web Store.' } })
})
await panel.reload()
await settle(400)
await shot('05-update-required.png')
await panel.evaluate(async () => { await chrome.storage.local.remove('updateNotice') })

// Promotional tiles in the Corsen connector style Hermes Connector set: the Corsen mark glowing on
// black, the product name, and one session's link fanning out to the tabs it was given. Drawn from
// HTML and SVG at capture time; the only bitmap is the Corsen mark itself (store/brand).
const corsenMark = `data:image/png;base64,${readFileSync(new URL('../store/brand/corsen-mark.png', import.meta.url)).toString('base64')}`

/**
 * One promotional image, laid out on a grid by the Store's own rules for them: mostly brand, little
 * text, legible at half size, the whole area filled, well-defined edges (developer.chrome.com,
 * "Supplying images"). The marquee has three columns — the mark, the name, and one session fanning
 * out to its tabs — sharing one horizontal axis; the small tile keeps only the mark and the name.
 * Margins are a fixed fraction of the height, and the name is shrunk until it fits its column, so
 * nothing touches an edge or another element.
 * @param name - the output file.
 * @param width - the image width.
 * @param height - the image height.
 */
async function tile(name: string, width: number, height: number): Promise<void> {
  const marquee = width >= 1000
  const margin = Math.round(height * (marquee ? 0.12 : 0.13))
  const markHeight = height - 2 * margin
  const markWidth = Math.round(markHeight * 344 / 373)
  const textLeft = margin + markWidth + Math.round(height * (marquee ? 0.12 : 0.07))
  const textRight = marquee ? Math.round(width * 0.66) : width - margin
  const centreY = height / 2

  // The fan: one node just right of the text column, four tab windows stacked against the right
  // margin, evenly spaced and centred on the same axis as everything else.
  let fan = ''
  if (marquee) {
    const tabW = 136
    const tabH = 82
    const gap = 26
    const stack = 4 * tabH + 3 * gap
    const tabX = width - margin - tabW
    const nodeX = textRight + 36
    const tones = ['#1fb7ff', '#3d7bff', '#9b5cff', '#ff4fd8']
    fan = `<circle cx="${nodeX}" cy="${centreY}" r="7" fill="#d6f1ff" filter="url(#glow)"/>`
    tones.forEach((tone, index) => {
      const top = centreY - stack / 2 + index * (tabH + gap)
      const y = top + tabH / 2
      fan += `<path d="M ${nodeX} ${centreY} C ${nodeX + 130} ${centreY}, ${tabX - 130} ${y}, ${tabX} ${y}" stroke="${tone}" stroke-width="2.6" fill="none" filter="url(#glow)"/>`
        + `<g transform="translate(${tabX} ${top})" filter="url(#soft)">`
        + `<rect width="${tabW}" height="${tabH}" rx="10" fill="rgba(18,26,58,.72)" stroke="${tone}" stroke-width="2"/>`
        + `<path d="M 0 22 H ${tabW}" stroke="${tone}" stroke-width="1.5"/>`
        + [14, 27, 40].map((dx) => `<circle cx="${dx}" cy="11" r="3.2" fill="${tone}"/>`).join('')
        + `<rect x="14" y="36" width="${tabW - 46}" height="6" rx="3" fill="${tone}" opacity=".35"/>`
        + `<rect x="14" y="52" width="${tabW - 70}" height="6" rx="3" fill="${tone}" opacity=".22"/>`
        + '</g>'
    })
  }

  const page = await harness.context.newPage()
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>tile</title>
<style>
  body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; position: relative;
    background: radial-gradient(55% 85% at ${Math.round((margin + markWidth / 2) / width * 100)}% 50%, rgba(56,118,255,.26), transparent 70%),
                radial-gradient(45% 70% at 70% 60%, rgba(150,80,255,.18), transparent 72%), #05060c;
    font-family: Montserrat, "Ubuntu Sans", "Segoe UI", sans-serif; color: #f4f6ff; }
  .mark { position: absolute; left: ${margin}px; top: ${margin}px; height: ${markHeight}px;
    filter: drop-shadow(0 0 ${Math.round(height * 0.03)}px rgba(64,170,255,.55)) drop-shadow(0 0 ${Math.round(height * 0.07)}px rgba(170,90,255,.30)); }
  .text { position: absolute; left: ${textLeft}px; width: ${textRight - textLeft}px; top: 50%; transform: translateY(-50%); }
  h1 { margin: 0; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; line-height: 1.02; white-space: nowrap;
    font-size: ${marquee ? 68 : 34}px; text-shadow: 0 0 ${Math.round(height * 0.03)}px rgba(120,160,255,.35); }
  .rule { margin-top: ${marquee ? 26 : 14}px; height: ${marquee ? 6 : 4}px; width: ${marquee ? 120 : 64}px; border-radius: 3px;
    background: linear-gradient(90deg, #22c7ff, #8c6bff 55%, #ff5bd6); box-shadow: 0 0 12px rgba(140,107,255,.6); }
  .by { margin: ${marquee ? 22 : 0}px 0 0; font-weight: 600; letter-spacing: .24em; font-size: 18px; color: #7fb2ff; text-transform: uppercase; }
  svg { position: absolute; inset: 0; }
</style>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  ${fan}
</svg>
<img class="mark" src="${corsenMark}" alt="">
<div class="text">
  <h1>DeepSeek<br>Harness<br>Connector</h1>
  <div class="rule"></div>
  ${marquee ? '<p class="by">by Corsen AI</p>' : ''}
</div>`)
  // Shrink the name until its widest line fits the column; never let it run into the fan or an edge.
  await page.evaluate(() => {
    const heading = document.querySelector('h1') as HTMLElement
    const column = (document.querySelector('.text') as HTMLElement).clientWidth
    let size = parseFloat(getComputedStyle(heading).fontSize)
    while (heading.scrollWidth > column && size > 10) { size -= 1; heading.style.fontSize = `${size}px` }
  })
  await settle(300)
  save(name, await page.screenshot({ type: 'png' }))
  await page.close()
}
await tile('promo-small-440x280.png', 440, 280)
await tile('promo-marquee-1400x560.png', 1400, 560)

process.stdout.write('\n| File | Bytes | SHA-256 |\n|---|---|---|\n')
for (const entry of written) process.stdout.write(`| \`${entry.file}\` | ${entry.bytes} | \`${entry.sha256}\` |\n`)

agent.dispose()
await harness.close()
