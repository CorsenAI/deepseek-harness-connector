/**
 * The browser half of the end-to-end setup: a Chromium with the extension, the fixture web server,
 * and the panel-driven helpers.
 *
 * Kept apart from `harness.ts` because it imports nothing from `companion/src/`: a test of the
 * released pair must run the packaged broker and the packaged plugin, and a helper that pulled the
 * source tree in beside them would blur what was actually under test. `harness.ts` builds on this
 * module and adds the in-process broker and agent every other suite uses.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'

/** This file's directory, for locating the extension and fixtures. */
const here = dirname(fileURLToPath(import.meta.url))

/** The unpacked extension Chromium loads. These are the files the Store package will contain. */
export const EXTENSION_DIR = join(here, '..', '..', 'extension')

/** Where the HTML fixtures live. */
export const FIXTURE_DIR = join(here, '..', 'fixtures')

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
 * Whether a headed Linux browser must be told to use X11, so that it draws on the display `DISPLAY`
 * names.
 *
 * With no `--ozone-platform`, Chrome for Testing 153 on Linux takes its window system from
 * `XDG_SESSION_TYPE` alone (`SetOzonePlatformForLinuxIfNeeded`, `ui/linux/display_server_utils.cc`):
 * in a desktop session on Wayland it opens on that desktop, and the `DISPLAY` that `xvfb-run` sets
 * is ignored. On 2026-11-05 every "headed under Xvfb" run on the development machine, a GNOME
 * session on Wayland, put its windows on the owner's screen; the browser log named the Wayland
 * platform. Asking for X11 whenever `DISPLAY` is set sends the window where `DISPLAY` points: the
 * virtual display under `xvfb-run`, as on CI, and the X server of the desktop (XWayland on a
 * Wayland session) for someone who runs the suites headed on purpose.
 * @param headless - whether the run is headless, which draws nowhere and needs no window system.
 * @param platform - the operating system, `process.platform` by default.
 * @param env - the environment, `process.env` by default.
 * @returns true for a headed run on Linux with an X display set.
 */
export function headedOnX11Display(headless: boolean, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return !headless && platform === 'linux' && Boolean(env['DISPLAY'])
}

/** What one browser launch produces. */
export interface LaunchedBrowser {
  context: BrowserContext
  worker: Worker
  extensionId: string
  /** A page at the extension origin, used exactly as the side panel uses the message API. */
  panel: Page
}

/** The part of a running browser the panel helpers need. */
export type PanelView = Pick<LaunchedBrowser, 'panel'>

/**
 * Launch Chromium with the extension and open the panel page.
 *
 * Playwright's own Chromium is required rather than the installed Chrome: current Chrome stable
 * refuses `--load-extension`, so the extension silently never loads and no service worker appears.
 * The browser is headed by default, because that is how users run it and because an MV3 service
 * worker does not start under the headless *shell*. With `DSH_E2E_HEADLESS=1` the full Chromium
 * runs in its new headless mode instead (Playwright's `chromium` channel, which its documentation
 * names as the way to run extensions headless) — for a machine with no display, such as one
 * driven over SSH. The evidence records which mode a run used.
 * @param userDataDir - the profile directory.
 * @param extensionDir - the extension to load.
 * @returns the context, its worker, the extension id, and the panel page.
 */
export async function launchBrowser(userDataDir: string, extensionDir: string): Promise<LaunchedBrowser> {
  const headless = process.env['DSH_E2E_HEADLESS'] === '1'
  // `DSH_E2E_LOCALE=fr-FR` runs the browser in another language, so the panel's other dictionary
  // is exercised on a machine whose own Chrome speaks English.
  const locale = process.env['DSH_E2E_LOCALE']
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    ...(headless ? { channel: 'chromium' as const } : {}),
    ...(locale ? { locale } : {}),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(headedOnX11Display(headless) ? ['--ozone-platform=x11'] : []),
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
 * Close a browser context without ever waiting on it forever.
 *
 * On the Windows lane of 2026-11-05 (an ARM64 VM running the x64 Chrome for Testing under
 * emulation) one suite's seven cases passed and its process then stayed open for 33 minutes in
 * teardown. A wedged `close()` must not hold a finished run: the teardown goes on after a bound,
 * says so, and the runner's `--test-force-exit` ends the file.
 * @param context - the context, if one was launched.
 * @param ms - how long to wait.
 * @returns whether it closed in time.
 */
export async function closeWithin(context: BrowserContext | undefined, ms = 20000): Promise<boolean> {
  if (!context) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, ms) }),
  ])
  clearTimeout(timer)
  if (!closed) process.stdout.write(`teardown: the browser context did not close within ${ms} ms; continuing\n`)
  return closed
}

/** A loopback server for the HTML fixtures. */
export interface FixtureServer {
  /** @returns the URL of one fixture by file name. */
  url(name: string): string
  close(): Promise<void>
}

/**
 * Serve `tests/fixtures/` over loopback, because an extension cannot act on `file:` pages.
 * @param generated - documents built by the caller, served under the given names beside the files.
 * @returns the running server.
 */
export async function serveFixtures(generated: Readonly<Record<string, string>> = {}): Promise<FixtureServer> {
  const files: Server = createServer((request, response) => {
    const name = String(request.url ?? '/').replace(/^\/+/, '').split('?')[0] ?? ''
    if (!/^[a-z0-9-]+\.html$/.test(name)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found\n')
      return
    }
    try {
      const body = generated[name] ?? readFileSync(join(FIXTURE_DIR, name), 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found\n')
    }
  })
  await new Promise<void>((resolve) => { files.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = files.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: (name) => `http://127.0.0.1:${port}/${name}`,
    close: async () => {
      // `close` waits for every connection to end. Chrome keeps sockets it opened speculatively —
      // connected, never used — and those are neither idle nor active to Node, so a close that only
      // shut idle ones hung the Windows lane after a cross-origin navigation. Destroy them all.
      await new Promise<void>((resolve) => {
        files.close(() => { resolve() })
        files.closeAllConnections()
      })
    },
  }
}

/**
 * Give the extension its broker address and pairing code, the way the panel's form does.
 *
 * The panel's form is exercised separately; driving storage here keeps the routing tests about
 * routing instead of about typing into a form.
 * @param view - the running browser.
 * @param brokerUrl - where the extension should connect.
 * @param code - the pairing code, as a user would type it.
 * @returns settlement once the extension has authenticated.
 */
export async function pairWith(view: PanelView, brokerUrl: string, code: string): Promise<void> {
  await view.panel.evaluate(async ([url, pairingCode]: string[]) => {
    await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl: url, pairingCode } })
  }, [brokerUrl, code])
  await waitFor('the extension to authenticate with the broker', () => extensionConnected(view))
}

/**
 * Whether the extension currently holds an authenticated broker connection.
 * @param view - the running browser.
 * @returns the panel's own view of the connection.
 */
export async function extensionConnected(view: PanelView): Promise<boolean> {
  const state = await view.panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'connector/state' }))
  return (state as { connected?: boolean } | undefined)?.connected === true
}

/**
 * Attach one open tab to one scope through the extension's own panel API.
 * @param view - the running browser.
 * @param scope - the profile and session.
 * @param tabId - the Chrome tab id.
 * @returns the reply the extension gave.
 */
export async function attachTab(
  view: PanelView,
  scope: { profileId: string, sessionId: string },
  tabId: number,
): Promise<{ ok: boolean, error?: string }> {
  const reply = await view.panel.evaluate(async (payload: Record<string, unknown>) => (
    await chrome.runtime.sendMessage({ type: 'connector/attach', ...payload })
  ), { ...scope, tabId })
  await settle()
  return reply as { ok: boolean, error?: string }
}

/**
 * The Chrome tab id of one open page.
 * @param view - the running browser.
 * @param url - the page's URL.
 * @returns the tab id.
 */
export async function tabIdFor(view: PanelView, url: string): Promise<number> {
  const id = await view.panel.evaluate(async (target: string) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url === target)?.id ?? -1
  }, url)
  if (id < 0) throw new Error(`no open tab for ${url}`)
  return id
}
