/**
 * The setup card a first-time user sees, in a real browser.
 *
 * Before pairing, the panel must say whether the local connector is there and what to run if it is
 * not, for the system Chrome is running on. The probe is a plain request from the extension page to
 * the connector address, so the answers are proven against a real broker on one port, an ordinary
 * web server on another, and a port nobody listens on. Once paired the card is gone; forgetting
 * the code brings it back.
 * @module
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { pairingCode } from '../../companion/src/auth.ts'
import { extensionConnected, settle, startHarness, waitFor, type Harness } from './harness.ts'

let harness: Harness
let silentPort: number

/** @returns a loopback port nothing is listening on right now. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => { resolvePort(port) })
    })
  })
}

/** What the panel shows in its setup card right now. */
interface CardView {
  hidden: boolean
  detection: string
  tone: string
  probe: string
  os: string
  installCommand: string
  codeCommand: string
  installer: string
  stepInstall: string
}

/** @returns the setup card as rendered. */
async function card(): Promise<CardView> {
  return await harness.panel.evaluate(() => {
    const section = document.getElementById('onboarding') as HTMLElement
    return {
      hidden: section.hidden,
      detection: document.getElementById('onboarding-detection')?.textContent ?? '',
      tone: document.getElementById('onboarding-detection')?.dataset['tone'] ?? '',
      probe: section.dataset['probe'] ?? '',
      os: section.dataset['os'] ?? '',
      installCommand: document.getElementById('cmd-install')?.textContent ?? '',
      codeCommand: document.getElementById('cmd-code')?.textContent ?? '',
      installer: document.getElementById('onboarding-installer')?.textContent ?? '',
      stepInstall: document.getElementById('onboarding-step-install')?.textContent ?? '',
    }
  })
}

/**
 * Point the panel at an address without pairing, exactly as the settings form does.
 * @param brokerUrl - the connector address.
 */
async function setAddress(brokerUrl: string): Promise<void> {
  await harness.panel.evaluate(async (url: string) => {
    await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl: url, pairingCode: '' } })
  }, brokerUrl)
}

/**
 * Wait until the card's probe settles on a verdict.
 * @param expected - the verdict.
 */
async function verdict(expected: string): Promise<CardView> {
  await waitFor(`the setup card to say ${expected}`, async () => (await card()).probe === expected, 20000)
  return await card()
}

before(async () => {
  harness = await startHarness()
  silentPort = await freePort()
}, { timeout: 120000 })

after(async () => { await harness?.close() })

describe('the setup card', () => {
  it('shows on first run, names the system Chrome runs on, and gives the commands for it', async () => {
    // The panel draws itself after its first round trip to the worker; the card is what it draws.
    await waitFor('the setup card to show before pairing', async () => !(await card()).hidden)
    const platform = await harness.panel.evaluate(async () => (await chrome.runtime.getPlatformInfo()).os)
    const expectedOs = ({ win: 'windows', mac: 'mac', linux: 'linux' } as Record<string, string>)[platform] ?? 'other'
    await waitFor('the platform to be read', async () => (await card()).os === expectedOs)
    const labelled = await card()
    const osName = ({ windows: 'Windows', mac: 'macOS', linux: 'Linux' } as Record<string, string>)[expectedOs] ?? 'this computer'
    assert.match(labelled.stepInstall, new RegExp(osName), `the step must name ${osName}; got: ${labelled.stepInstall}`)
    assert.equal(labelled.installCommand, 'dsh plugin --profile web add @corsen-ai/dsh-browser-connector')
    assert.equal(labelled.codeCommand, 'dsh plugin --profile web exec dsh-connector-broker --pairing-code')
    assert.match(labelled.installer, expectedOs === 'windows' ? /Install Connector\.cmd/ : /install\.sh/)
  })

  it('says a connector is running when the address answers 426, and what to do next', async () => {
    await setAddress(`ws://127.0.0.1:${harness.broker.port}`)
    const view = await verdict('running')
    assert.equal(view.tone, 'ok')
    assert.match(view.detection, /A connector is running at 127\.0\.0\.1:\d+/)
    assert.match(view.detection, /Type its pairing code below/)
  })

  it('says nothing is listening when nothing is, and that the install comes first', async () => {
    await setAddress(`ws://127.0.0.1:${silentPort}`)
    const view = await verdict('none')
    assert.equal(view.tone, 'idle')
    assert.match(view.detection, /No connector is listening at 127\.0\.0\.1:\d+/)
    assert.match(view.detection, /Install it, then start DeepSeek Harness/)
  })

  it('tells another program on the port apart from the connector', async () => {
    // The fixture web server answers a plain request with 404: a server, not the broker.
    const fixtures = new URL(harness.pageUrl('page-a.html'))
    await setAddress(`ws://${fixtures.host}`)
    const view = await verdict('other')
    assert.equal(view.tone, 'warn')
    assert.match(view.detection, /Something other than the connector answers/)
  })

  it('notices a connector that appears after the card was drawn, without the user doing anything', async () => {
    await setAddress(`ws://127.0.0.1:${silentPort}`)
    await verdict('none')
    // The broker moves to the silent port: the same thing as a user starting DeepSeek Harness.
    await harness.broker.close()
    const { startBroker } = await import('../../companion/src/broker-server.ts')
    harness.broker = await startBroker({ secret: harness.secret, version: '0.1.0', port: silentPort, store: { load: () => ({ scopeOwners: {} }), save: () => {} } })
    const view = await verdict('running')
    assert.equal(view.tone, 'ok')
  })

  it('disappears once paired, and comes back when the code is forgotten', async () => {
    await harness.panel.evaluate(async ([url, code]: string[]) => {
      await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl: url, pairingCode: code } })
    }, [`ws://127.0.0.1:${harness.broker.port}`, pairingCode(harness.secret)])
    await waitFor('the extension to pair', () => extensionConnected(harness))
    await waitFor('the card to go', async () => (await card()).hidden)

    await setAddress(`ws://127.0.0.1:${harness.broker.port}`)
    await settle(300)
    await waitFor('the card to return', async () => !(await card()).hidden)
    const view = await verdict('running')
    assert.match(view.detection, /A connector is running/)
  })
})
