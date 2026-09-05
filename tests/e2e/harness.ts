/**
 * Shared setup for the real-browser end-to-end tests.
 *
 * These tests run the actual shipped bits: a real broker process object, a real Chromium with the
 * real unpacked extension, and a real `AgentClient` standing in for a DeepSeek Harness plugin. The
 * only thing simulated is DeepSeek Harness itself, because a model in the loop would make the tests
 * non-deterministic without proving anything more about routing.
 *
 * The harness can also take its own components away and bring them back — the broker, the
 * extension's service worker, the whole browser — so the recovery suite can prove what happens
 * when they die mid-flight.
 *
 * @module
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'
import { AgentClient } from '../../companion/src/agent-client.ts'
import { createSecret, pairingCode } from '../../companion/src/auth.ts'
import { startBroker, type RunningBroker } from '../../companion/src/broker-server.ts'
import type { StateStore } from '../../companion/src/broker.ts'
import { fileStateStore } from '../../companion/src/state-store.ts'

/** This file's directory, for locating the extension and fixtures. */
const here = dirname(fileURLToPath(import.meta.url))

/** The unpacked extension Chromium loads. These are the files the Store package will contain. */
export const EXTENSION_DIR = join(here, '..', '..', 'extension')

/** Where the HTML fixtures live. */
const FIXTURE_DIR = join(here, '..', 'fixtures')

/** The connector version every component reports. */
const VERSION = '0.1.0'

/** How the harness is started. */
export interface HarnessOptions {
  /** The extension directory to load. The packaged-ZIP test points this at an unpacked archive. */
  extensionDir?: string
  /** A browser profile directory that survives {@link Harness.relaunchChrome}. Created if absent. */
  userDataDir?: string
  /** Persist broker ownership in this file, so {@link Harness.restartBroker} restores it from disk. */
  stateFile?: string
}

/** Everything one end-to-end test needs. Fields that a restart replaces are not readonly. */
export interface Harness {
  broker: RunningBroker
  context: BrowserContext
  worker: Worker
  extensionId: string
  /** A page at the extension origin, used exactly as the side panel uses the message API. */
  panel: Page
  readonly secret: string
  readonly userDataDir: string
  readonly stateFile: string | null
  readonly pageUrl: (name: string) => string
  /**
   * @param sessions - sessions this simulated DeepSeek Harness process has live.
   * @returns a connected agent client.
   */
  agent(profileId: string, sessions: string[]): Promise<AgentClient>
  /** Stop the broker and start a new one on the same port, reading ownership back from disk. */
  restartBroker(): Promise<void>
  /** Close the whole browser and launch it again on the same profile directory. */
  relaunchChrome(): Promise<void>
  /** Terminate the extension's service worker, the way Chrome does when it evicts one. */
  killWorker(): Promise<void>
  /** Send the worker an ordinary panel message, which makes Chrome start it again. */
  wakeWorker(): Promise<void>
  close(): Promise<void>
}

/** In-memory ownership storage, isolated per test file. */
function memoryStore(): StateStore {
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

/** What one browser launch produces. */
interface LaunchedBrowser {
  context: BrowserContext
  worker: Worker
  extensionId: string
  panel: Page
}

/**
 * Launch Chromium with the extension and open the panel page.
 *
 * Playwright's own Chromium is required rather than the installed Chrome: current Chrome stable
 * refuses `--load-extension`, so the extension silently never loads and no service worker appears.
 * Headed mode is required too, because an MV3 service worker does not start under the headless
 * shell, and a test against a worker that never runs proves nothing.
 * @param userDataDir - the profile directory.
 * @param extensionDir - the extension to load.
 * @returns the context, its worker, the extension id, and the panel page.
 */
async function launchBrowser(userDataDir: string, extensionDir: string): Promise<LaunchedBrowser> {
  const context = await chromium.launchPersistentContext(userDataDir, {
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
  return { context, worker, extensionId, panel }
}

/**
 * Start a broker, a fixture web server, and a Chromium with the extension loaded.
 * @param options - extension directory, profile directory, and ownership state file.
 * @returns the harness.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const extensionDir = options.extensionDir ?? EXTENSION_DIR
  const ownsUserDataDir = options.userDataDir === undefined
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'dsh-connector-profile-'))
  const stateFile = options.stateFile ?? null
  const secret = createSecret()

  // One store object for the process when nothing is persisted; a fresh file-backed store on every
  // start when a state file is given, so a restart proves the file rather than a shared object.
  const sharedMemory = memoryStore()
  const store = (): StateStore => (stateFile === null ? sharedMemory : fileStateStore(stateFile))
  let broker = await startBroker({ secret, version: VERSION, port: 0, store: store() })

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

  const launched = await launchBrowser(userDataDir, extensionDir)
  const agents: AgentClient[] = []

  const harness: Harness = {
    broker,
    context: launched.context,
    worker: launched.worker,
    extensionId: launched.extensionId,
    panel: launched.panel,
    secret,
    userDataDir,
    stateFile,
    pageUrl: (name) => `http://127.0.0.1:${filesPort}/${name}`,

    agent: async (profileId, sessions) => {
      const client = new AgentClient({
        url: `ws://127.0.0.1:${harness.broker.port}`,
        secret,
        version: VERSION,
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

    restartBroker: async () => {
      const port = harness.broker.port
      await harness.broker.close()
      // The same port, so the extension's stored address and every agent's URL stay valid, and a
      // freshly constructed store, so ownership provably comes back from the file.
      broker = await startBroker({ secret, version: VERSION, port, store: store() })
      harness.broker = broker
    },

    relaunchChrome: async () => {
      await harness.context.close()
      const again = await launchBrowser(userDataDir, extensionDir)
      harness.context = again.context
      harness.worker = again.worker
      harness.extensionId = again.extensionId
      harness.panel = again.panel
    },

    killWorker: async () => {
      // The panel page shares the extension's origin, so its CDP session sees the extension's own
      // service worker registration and may stop it, exactly as Chrome does when it evicts a worker.
      const cdp = await harness.context.newCDPSession(harness.panel)
      const running = new Map<string, string>()
      cdp.on('ServiceWorker.workerVersionUpdated', (event: { versions: { versionId: string, runningStatus: string, scriptURL: string }[] }) => {
        for (const version of event.versions) {
          if (version.scriptURL.includes('background.js')) running.set(version.versionId, version.runningStatus)
        }
      })
      await cdp.send('ServiceWorker.enable')
      await waitFor('the worker registration to be reported', () => running.size > 0, 5000)
      for (const [versionId, status] of running) {
        if (status === 'running' || status === 'starting') await cdp.send('ServiceWorker.stopWorker', { versionId })
      }
      await waitFor('the worker to stop', () => [...running.values()].every((status) => status === 'stopped'), 5000)
      await cdp.detach()
    },

    wakeWorker: async () => {
      await harness.panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'connector/state' }) })
    },

    close: async () => {
      for (const client of agents) client.dispose()
      await harness.context.close()
      await harness.broker.close()
      await new Promise<void>((resolve) => { files.close(() => { resolve() }) })
      // Chrome can hold profile files for a moment after it exits, especially on Windows; a
      // leftover temporary profile is a nuisance, not a test failure.
      if (ownsUserDataDir) {
        try {
          rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        } catch (cause) {
          process.stderr.write(`note: could not remove temporary profile ${userDataDir}: ${String((cause as Error).message)}\n`)
        }
      }
    },
  }
  return harness
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

  await waitFor('the extension to authenticate with the broker', () => extensionConnected(harness))
}

/**
 * Whether the extension currently holds an authenticated broker connection.
 * @param harness - the running harness.
 * @returns the panel's own view of the connection.
 */
export async function extensionConnected(harness: Harness): Promise<boolean> {
  const state = await harness.panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'connector/state' }))
  return (state as { connected?: boolean } | undefined)?.connected === true
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
