/**
 * Shared setup for the real-browser end-to-end tests.
 *
 * These tests run the actual shipped bits: a real broker process object, a real Chromium with the
 * real unpacked extension, and a real `AgentClient` standing in for a DeepSeek Harness plugin. The
 * only thing simulated is DeepSeek Harness itself, because a model in the loop would make the tests
 * non-deterministic without proving anything more about routing.
 *
 * @module
 */

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'
import { AgentClient } from '../../companion/src/agent-client.ts'
import { createSecret, pairingCode } from '../../companion/src/auth.ts'
import { startBroker, type RunningBroker } from '../../companion/src/broker-server.ts'
import type { StateStore } from '../../companion/src/broker.ts'

/** This file's directory, for locating the extension and fixtures. */
const here = dirname(fileURLToPath(import.meta.url))

/** The unpacked extension Chromium loads. These are the files the Store package will contain. */
export const EXTENSION_DIR = join(here, '..', '..', 'extension')

/** Where the HTML fixtures live. */
const FIXTURE_DIR = join(here, '..', 'fixtures')

/** Everything one end-to-end test needs. */
export interface Harness {
  readonly broker: RunningBroker
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  /** A page at the extension origin, used exactly as the side panel uses the message API. */
  readonly panel: Page
  readonly secret: string
  readonly pageUrl: (name: string) => string
  /**
   * @param sessions - sessions this simulated DeepSeek Harness process has live.
   * @returns a connected agent client.
   */
  agent(profileId: string, sessions: string[]): Promise<AgentClient>
  close(): Promise<void>
}

/** In-memory ownership storage, isolated per test file. */
function store(): StateStore {
  let held = { scopeOwners: {} as Record<string, string> }
  return { load: () => held, save: (state) => { held = { scopeOwners: { ...state.scopeOwners } } } }
}

/** Let queued frames and Chrome events settle. */
export async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until a condition holds, or fail with a message naming what never happened.
 * @param describe - what is being waited for, used in the failure.
 * @param check - the condition.
 * @param timeoutMs - how long to wait.
 * @returns settlement once the condition holds.
 * @throws when the condition never holds.
 */
export async function waitFor(describe: string, check: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`)
    await settle(60)
  }
}

/**
 * Start a broker, a fixture web server, and a Chromium with the extension loaded.
 *
 * Playwright's own Chromium is required rather than the installed Chrome: current Chrome stable
 * refuses `--load-extension`, so the extension silently never loads and no service worker appears.
 * Headed mode is required too, because an MV3 service worker does not start under the headless
 * shell, and a test against a worker that never runs proves nothing.
 * @returns the harness.
 */
export async function startHarness(options: { extensionDir?: string } = {}): Promise<Harness> {
  // The packaged-ZIP test points this at an unpacked release archive, so the same suite proves
  // the shipped bytes and not only the source tree (gate AD).
  const extensionDir = options.extensionDir ?? EXTENSION_DIR
  const secret = createSecret()
  const broker = await startBroker({ secret, version: '0.1.0', port: 0, store: store() })

  const files: Server = createServer((request, response) => {
    const name = String(request.url ?? '/').replace(/^\/+/, '').split('?')[0] ?? ''
    if (!/^[a-z0-9-]+\.html$/.test(name)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found\n')
      return
    }
    try {
      const body = readFileSync(join(FIXTURE_DIR, name), 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found\n')
    }
  })
  await new Promise<void>((resolve) => { files.listen(0, '127.0.0.1', () => { resolve() }) })
  const filesAddress = files.address()
  const filesPort = typeof filesAddress === 'object' && filesAddress !== null ? filesAddress.port : 0

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  // The service worker appears shortly after launch; Playwright may or may not have seen it yet.
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 })
  const extensionId = new URL(worker.url()).host

  // The panel page is the control surface: a service worker's own `sendMessage` never reaches its own
  // listener, and driving the extension the way the panel does keeps the tested path the real path.
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`)

  const agents: AgentClient[] = []

  return {
    broker,
    context,
    worker,
    extensionId,
    panel,
    secret,
    pageUrl: (name) => `http://127.0.0.1:${filesPort}/${name}`,

    agent: async (profileId, sessions) => {
      const client = new AgentClient({
        url: `ws://127.0.0.1:${broker.port}`,
        secret,
        version: '0.1.0',
        profileId,
        name: `DeepSeek Harness (${profileId})`,
      })
      agents.push(client)
      client.start()
      await waitFor(`agent ${profileId} to pair with the broker`, () => client.connected)
      for (const sessionId of sessions) client.addSession(sessionId, `Session ${sessionId}`)
      await settle()
      return client
    },

    close: async () => {
      for (const client of agents) client.dispose()
      await context.close()
      await broker.close()
      await new Promise<void>((resolve) => { files.close(() => { resolve() }) })
    },
  }
}

/**
 * Pair the extension with the broker by writing its settings, the way the panel does.
 *
 * The panel's form is exercised separately; driving storage here keeps the routing tests about
 * routing instead of about typing into a form.
 * @param harness - the running harness.
 * @returns settlement once the extension has authenticated.
 */
export async function pairExtension(harness: Harness): Promise<void> {
  await harness.panel.evaluate(async ([brokerUrl, code]: string[]) => {
    await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl, pairingCode: code } })
  }, [`ws://127.0.0.1:${harness.broker.port}`, pairingCode(harness.secret)])

  await waitFor('the extension to authenticate with the broker', async () => (
    await harness.panel.evaluate(async () => {
      const state = await chrome.runtime.sendMessage({ type: 'connector/state' })
      return state?.connected === true
    })
  ))
}

/**
 * Attach one open tab to one scope through the extension's own panel API.
 * @param harness - the running harness.
 * @param scope - the profile and session.
 * @param tabId - the Chrome tab id.
 * @returns the reply the extension gave.
 */
export async function attachTab(
  harness: Harness,
  scope: { profileId: string, sessionId: string },
  tabId: number,
): Promise<{ ok: boolean, error?: string }> {
  const reply = await harness.panel.evaluate(async (payload: Record<string, unknown>) => (
    await chrome.runtime.sendMessage({ type: 'connector/attach', ...payload })
  ), { ...scope, tabId })
  await settle()
  return reply as { ok: boolean, error?: string }
}

/**
 * The Chrome tab id of one open page.
 * @param harness - the running harness.
 * @param url - the page's URL.
 * @returns the tab id.
 */
export async function tabIdFor(harness: Harness, url: string): Promise<number> {
  const id = await harness.panel.evaluate(async (target: string) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url === target)?.id ?? -1
  }, url)
  if (id < 0) throw new Error(`no open tab for ${url}`)
  return id
}
