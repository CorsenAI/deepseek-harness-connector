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
import { mkdirSync, writeFileSync } from 'node:fs'
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

// Promotional tiles, rendered from the extension's own palette and mark.
async function tile(name: string, width: number, height: number, titleSize: number, subtitleSize: number): Promise<void> {
  const page = await harness.context.newPage()
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>tile</title>
<style>
  body { margin: 0; width: ${width}px; height: ${height}px; box-sizing: border-box; padding: 0 ${Math.round(width * 0.07)}px; background: radial-gradient(120% 140% at 15% 20%, #1b2233 0%, #0e1016 55%); color: #e7ebf3; font-family: Inter, "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; gap: ${Math.round(width * 0.06)}px; }
  .mark { width: ${Math.round(height * 0.34)}px; height: ${Math.round(height * 0.34)}px; border-radius: ${Math.round(height * 0.07)}px; background: #161a23; border: 2px solid #242a36; position: relative; flex: none; }
  .mark::before, .mark::after { content: ""; position: absolute; background: #58a6ff; border-radius: 2px; }
  .mark::before { left: 24%; top: 22%; width: 9%; height: 56%; }
  .mark::after { left: 20%; top: 46%; width: 62%; height: 9%; }
  .text { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  h1 { margin: 0; font-size: ${titleSize}px; font-weight: 700; letter-spacing: -0.01em; }
  p { margin: 0; font-size: ${subtitleSize}px; color: #98a2b6; }
</style>
<div class="mark" aria-hidden="true"></div>
<div class="text"><h1>DeepSeek Harness Connector</h1><p>Your DeepSeek session, in the tabs you choose.</p></div>`)
  await settle(200)
  save(name, await page.screenshot({ type: 'png' }))
  await page.close()
}
await tile('promo-small-440x280.png', 440, 280, 21, 13)
await tile('promo-marquee-1400x560.png', 1400, 560, 54, 26)

process.stdout.write('\n| File | Bytes | SHA-256 |\n|---|---|---|\n')
for (const entry of written) process.stdout.write(`| \`${entry.file}\` | ${entry.bytes} | \`${entry.sha256}\` |\n`)

agent.dispose()
await harness.close()
