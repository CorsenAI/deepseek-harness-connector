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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, Page, Worker } from 'playwright'
import { AgentClient } from '../../companion/src/agent-client.ts'
import { createSecret, pairingCode } from '../../companion/src/auth.ts'
import { startBroker, type RunningBroker } from '../../companion/src/broker-server.ts'
import type { StateStore } from '../../companion/src/broker.ts'
import { fileStateStore } from '../../companion/src/state-store.ts'
import {
  attachTab, closeWithin, EXTENSION_DIR, extensionConnected, launchBrowser, pairWith, serveFixtures, settle, tabIdFor, waitFor,
} from './browser.ts'

// The browser-only helpers are re-exported so every suite keeps one import.
export { attachTab, EXTENSION_DIR, extensionConnected, settle, tabIdFor, waitFor }

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
  /** Documents built by the caller, served by the fixture server under the given names. */
  generatedPages?: Readonly<Record<string, string>>
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

  const files = await serveFixtures(options.generatedPages ?? {})

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
    pageUrl: (name) => files.url(name),

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
      // Bounded: a browser whose close wedges (seen on the Windows ARM64 VM, the x64 Chrome under
      // emulation) must not hold a finished suite. relaunchChrome keeps the plain close, because
      // it launches again on the same profile directory.
      await closeWithin(harness.context)
      await harness.broker.close()
      await files.close()
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
 * Pair the extension with the harness's broker, the way the panel does.
 * @param harness - the running harness.
 * @param brokerUrl - where the extension should connect; defaults to the harness's own broker. A
 * test that records the wire gives the address of its relay instead.
 * @returns settlement once the extension has authenticated.
 */
export async function pairExtension(harness: Harness, brokerUrl = `ws://127.0.0.1:${harness.broker.port}`): Promise<void> {
  await pairWith(harness, brokerUrl, pairingCode(harness.secret))
}
