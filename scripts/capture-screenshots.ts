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

async function tile(name: string, width: number, height: number): Promise<void> {
  // The marquee carries the fan from one session to its tabs; the small tile is the mark and the
  // name alone, which is all 440 pixels can say cleanly.
  const compact = width < 800
  const unit = height / 560
  const px = (value: number): string => `${Math.round(value * unit)}px`
  const tabs = [0.2, 0.4, 0.6, 0.8].map((y) => y * height)
  const fromX = width * 0.62
  const fromY = height * 0.76
  const tabX = width - 150 * unit
  const curves = compact ? '' : `<circle cx="${fromX}" cy="${fromY}" r="${6 * unit}" fill="#bfe8ff" filter="url(#glow)"/>` + tabs.map((y, index) => {
    const tone = ['#1fb7ff', '#3d7bff', '#9b5cff', '#ff4fd8'][index]
    return `<path d="M ${fromX} ${fromY} C ${fromX + 260 * unit} ${fromY}, ${tabX - 150 * unit} ${y}, ${tabX} ${y}" stroke="${tone}" stroke-width="${2.6 * unit}" fill="none" filter="url(#glow)"/>`
      + `<circle cx="${tabX}" cy="${y}" r="${5 * unit}" fill="#fff" filter="url(#glow)"/>`
      + `<g transform="translate(${tabX} ${y - 34 * unit})" filter="url(#soft)">`
      + `<rect width="${126 * unit}" height="${78 * unit}" rx="${10 * unit}" fill="rgba(20,28,60,.55)" stroke="${tone}" stroke-width="${2 * unit}"/>`
      + `<path d="M 0 ${20 * unit} H ${126 * unit}" stroke="${tone}" stroke-width="${1.5 * unit}"/>`
      + [12, 24, 36].map((dx) => `<circle cx="${dx * unit}" cy="${10 * unit}" r="${3 * unit}" fill="${tone}"/>`).join('')
      + '</g>'
  }).join('')
  const layout = compact
    ? { markLeft: '16px', markHeight: '206px', textLeft: '212px', title: '25px', tagline: '12.5px', taglineGap: '12px', by: '8.5px', byGap: '13px' }
    : { markLeft: px(70), markHeight: px(400), textLeft: px(470), title: px(52), tagline: px(27), taglineGap: px(22), by: px(16), byGap: px(24) }
  const page = await harness.context.newPage()
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>tile</title>
<style>
  body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; position: relative;
    background: radial-gradient(60% 90% at 18% 55%, rgba(61,123,255,.20), transparent 70%),
                radial-gradient(40% 60% at 60% 85%, rgba(155,92,255,.16), transparent 70%), #04050a;
    font-family: Montserrat, "Ubuntu Sans", "Segoe UI", sans-serif; color: #f4f6ff; }
  .mark { position: absolute; left: ${layout.markLeft}; top: 50%; height: ${layout.markHeight}; transform: translateY(-50%);
    filter: drop-shadow(0 0 ${px(18)} rgba(64,170,255,.55)) drop-shadow(0 0 ${px(42)} rgba(170,90,255,.35)); }
  .text { position: absolute; left: ${layout.textLeft}; top: 50%; transform: translateY(-${compact ? 50 : 62}%); }
  h1 { margin: 0; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; line-height: 1.04;
    font-size: ${layout.title}; text-shadow: 0 0 ${px(18)} rgba(120,160,255,.35); }
  .tagline { margin: ${layout.taglineGap} 0 0; font-weight: 700; letter-spacing: .08em; font-size: ${layout.tagline}; text-transform: uppercase;
    background: linear-gradient(90deg, #22c7ff, #8c6bff 55%, #ff5bd6); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .by { margin: ${layout.byGap} 0 0; font-weight: 600; letter-spacing: .2em; font-size: ${layout.by}; color: #6ea8ff; text-transform: uppercase; }
  svg { position: absolute; inset: 0; }
</style>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${3 * unit}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${1.2 * unit}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  ${curves}
</svg>
<img class="mark" src="${corsenMark}" alt="">
<div class="text">
  <h1>${compact ? 'DeepSeek<br>Harness<br>Connector' : 'DeepSeek Harness<br>Connector'}</h1>
  <p class="tagline">Your session.${compact ? '<br>' : ' '}Your tabs.</p>
  <p class="by">Unofficial &middot; by Corsen AI</p>
</div>`)
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
