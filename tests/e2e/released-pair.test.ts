/**
 * The released pair, installed the way a user installs it (gate AQ).
 *
 * Every other suite tests one artifact while importing the other side from the source tree, and
 * the recovery suite restarts a broker object rather than a broker process. This one takes only
 * what a user receives: the tarball in `dist/` goes into a real DeepSeek Harness with
 * `dsh plugin add`, that DeepSeek Harness applies the plugin, the broker is started as its own
 * process from the installed `lib/`, the ZIP in `dist/` is unpacked and loaded into Chromium, the
 * two pair with the code the installed broker prints, and one action runs through the installed
 * tool layer — the real `defineTool` that DeepSeek Harness resolved for the installed package.
 * Then the broker process is killed and started again, and the next action succeeds without the
 * user attaching anything again.
 *
 * Nothing here imports from `companion/src/`. The agent client, the tool layer and the credentials
 * reader are loaded from the installation directory, by file URL.
 *
 * Needs `dist/` built by `scripts/package.mjs` and a real `dsh`: `DSH_BIN_DIR` names the directory
 * holding it, or the first `~/dsh-int/<lane>/node_modules/.bin/dsh` is used. Without either the
 * suite is skipped and says so; a skipped gate is not a passed gate.
 * @module
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { readZip } from '../../scripts/package.mjs'
import {
  attachTab, extensionConnected, launchBrowser, pairWith, serveFixtures, settle, tabIdFor, waitFor,
  type FixtureServer, type LaunchedBrowser,
} from './browser.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'dist')
const PROFILE = 'web.rel000000001'
const SESSION = 'released-session'
const SCOPE = { profileId: PROFILE, sessionId: SESSION }

/** The installed connector's `lib/`, as loaded at runtime. */
interface InstalledLib {
  AgentClient: new (options: Record<string, unknown>) => {
    start(): void
    dispose(): void
    addSession(id: string, title: string): void
    readonly connected: boolean
  }
  registerBrowserTools: (ctx: unknown, dependencies: { client: unknown }) => void
  loadOrCreateCredentials: (path: string) => { secret: string }
  credentialsPath: (home: string) => string
  brokerStatePath: (home: string) => string
}

/** One registered tool, as the tool layer hands it to the registry. */
interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

let home: string
let unpacked: string
let installed: string
let brokerPort: number
let broker: ChildProcess | null = null
let brokerLog: string
let code: string
let files: FixtureServer
let browser: LaunchedBrowser
let lib: InstalledLib
let agent: InstanceType<InstalledLib['AgentClient']>
const tools = new Map<string, RegisteredTool>()
let tarball: string
let zip: string
let manifest: { version: string, commit: string, artifacts: { name: string, sha256: string }[] }

/** @returns the directory holding a real `dsh`, or null with the reason. */
function findDsh(): string | null {
  const fromEnv = process.env['DSH_BIN_DIR']
  if (fromEnv) return existsSync(join(fromEnv, 'dsh')) ? fromEnv : null
  const lanes = join(homedir(), 'dsh-int')
  if (!existsSync(lanes)) return null
  for (const lane of readdirSync(lanes).sort()) {
    const bin = join(lanes, lane, 'node_modules', '.bin')
    if (existsSync(join(bin, 'dsh'))) return bin
  }
  return null
}

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

/**
 * Run a command to completion.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns exit status and captured output; a status of null means the process could not start.
 */
function run(command: string, args: string[]): { status: number | null, out: string } {
  const result = spawnSync(command, args, {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    cwd: home,
    maxBuffer: 16 * 1024 * 1024,
  })
  const failure = result.error ? `\n[spawn] ${result.error.message}` : ''
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}${failure}` }
}

/**
 * Run the real `dsh` CLI.
 *
 * The bin directory holds a POSIX shim and a `.cmd` shim; neither is what a user's shell runs on
 * every platform, and the `.cmd` one needs a shell that would re-split a spaced path (the upstream
 * limitation recorded in docs/COMPATIBILITY.md). The CLI's own entry file, run by this Node, is the
 * same program on every platform with no shell in between.
 * @param args - CLI arguments.
 * @returns exit status and captured output.
 */
function dsh(args: string[]): { status: number | null, out: string } {
  const entry = join(dshBin as string, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(entry)) return run(process.execPath, [entry, ...args])
  return run(join(dshBin as string, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), args)
}

/** @returns the HTTP status the broker port answers with, or 0 when nothing answers. */
async function brokerAnswers(): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${brokerPort}/`)
    return response.status
  } catch {
    return 0
  }
}

/** Start the installed broker as its own process and wait until it listens. */
async function startBrokerProcess(): Promise<void> {
  const child = spawn(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--home', home, '--port', String(brokerPort)], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(`[broker] ${chunk.toString()}`) })
  child.stderr?.on('data', (chunk: Buffer) => { process.stdout.write(`[broker!] ${chunk.toString()}`) })
  broker = child
  await waitFor('the packaged broker process to listen', async () => await brokerAnswers() === 426, 20000)
}

/** Stop the broker process the way a crash would, and wait for the port to go quiet. */
async function killBrokerProcess(): Promise<void> {
  const child = broker
  assert.ok(child, 'no broker process to kill')
  const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
  child.kill('SIGKILL')
  await exited
  broker = null
  await waitFor('the broker port to stop answering', async () => await brokerAnswers() === 0, 10000)
}

/**
 * Run one browser tool exactly as the installed plugin would.
 * @param name - the tool.
 * @param args - its arguments.
 * @returns the payload the model would receive.
 */
async function runTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  assert.ok(tool, `${name} was not registered by the installed tool layer`)
  return await tool.execute(args, { signal: new AbortController().signal, agent: { id: SESSION } }) as Record<string, unknown>
}

/** @returns the panel's own state. */
async function panelState(): Promise<Record<string, unknown>> {
  return await browser.panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'connector/state' })) as Record<string, unknown>
}

// Whether the run can happen at all is decided when the file loads, because `skip` is read when
// each case is declared. The reason is printed, so a skipped gate can never pass quietly.
const artifacts = existsSync(DIST) ? readdirSync(DIST) : []
const tgzName = artifacts.find((name) => /^corsen-ai-dsh-browser-connector-.*\.tgz$/.test(name))
const zipName = artifacts.find((name) => /^dsh-browser-connector-extension-.*\.zip$/.test(name))
const dshBin = findDsh()
const skipReason: string | false = (!tgzName || !zipName || !existsSync(join(DIST, 'release-manifest.json')))
  ? 'dist/ holds no release artifacts; run `node scripts/package.mjs --out dist` first'
  : dshBin === null
    ? 'no real dsh found: set DSH_BIN_DIR to a directory holding `dsh`, or install one under ~/dsh-int/<lane>'
    : false
if (skipReason) process.stdout.write(`released pair: SKIPPED — ${skipReason}\n`)

before(async () => {
  if (skipReason || !tgzName || !zipName) return
  const tgz = tgzName
  tarball = join(DIST, tgz)
  zip = join(DIST, zipName)
  manifest = JSON.parse(readFileSync(join(DIST, 'release-manifest.json'), 'utf8')) as typeof manifest

  home = mkdtempSync(join(tmpdir(), 'dsh-connector-pair-home-'))
  unpacked = mkdtempSync(join(tmpdir(), 'dsh-connector-pair-ext-'))
  installed = join(home, 'profiles', 'headless', 'node_modules', '@corsen-ai', 'dsh-browser-connector')
  brokerPort = await freePort()
  brokerLog = join(home, 'connector', 'broker.log')
  process.stdout.write(`released pair: dsh at ${String(dshBin)}, home ${home}, tarball ${tgz}, zip ${zipName}\n`)
}, { timeout: 60000 })

after(async () => {
  agent?.dispose()
  if (broker) { broker.kill('SIGKILL'); broker = null }
  await browser?.context.close()
  await files?.close()
  for (const dir of [home, unpacked]) {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

describe('the released pair, installed as a user installs it', () => {
  it('installs the tarball into a real DeepSeek Harness with dsh plugin add, and the profile composes it', { timeout: 180000, skip: skipReason }, () => {
    const version = dsh(['--version'])
    process.stdout.write(`dsh --version: ${version.out.trim()}\n`)

    const added = dsh(['plugin', '--profile', 'headless', 'add', tarball])
    assert.equal(added.status, 0, `dsh plugin add failed:\n${added.out}`)
    const profileManifest = JSON.parse(readFileSync(join(home, 'profiles', 'headless', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    assert.ok(profileManifest.dsh.profile.bundles.includes('@corsen-ai/dsh-browser-connector'), 'the bundle must join the profile layer stack')
    assert.ok(existsSync(join(installed, 'lib', 'broker-main.js')), 'the installed package must carry the broker')
    assert.ok(existsSync(join(installed, 'lib', 'plugin.js')), 'the installed package must carry the plugin')

    const dumped = dsh(['--profile', 'headless', '--dump-config'])
    assert.equal(dumped.status, 0, `--dump-config failed:\n${dumped.out}`)
    assert.match(dumped.out, /corsen-browser-connector/, 'the composed tree must contain the plugin')
  })

  it('applies the installed plugin in a real DeepSeek Harness process; the only failure left is the missing API key', { timeout: 180000, skip: skipReason }, () => {
    // A real profile launch: DeepSeek Harness composes the tree, applies every plugin, and stops at
    // the model call because this environment holds no API key. Anything the connector says here
    // is a failure of the connector.
    const launched = dsh(['--profile', 'headless', 'say hi'])
    assert.doesNotMatch(launched.out, /corsen-browser-connector/, `the connector complained while applying:\n${launched.out}`)
    assert.match(launched.out, /MISSING_CREDENTIAL|API key/, `expected only the missing credential; got:\n${launched.out}`)
    // The launch is also what makes the installation resolvable: DeepSeek Harness links its own
    // packages beside the profile so the installed connector can import the real `defineTool`.
    assert.ok(existsSync(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools')), 'DeepSeek Harness must have linked dsh-tools for the profile')
  })

  it('runs the packaged broker as its own process, and the packaged extension pairs with the code it prints', { timeout: 120000, skip: skipReason }, async () => {
    await startBrokerProcess()
    const printed = run(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--pairing-code', '--home', home])
    assert.equal(printed.status, 0, printed.out)
    code = printed.out.trim().split('\n').pop() ?? ''
    assert.match(code, /^[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}$/, `not a pairing code: ${code}`)

    // The ZIP's own bytes, unpacked, are what Chromium loads.
    const bytes = readFileSync(zip)
    for (const entry of readZip(bytes) as { name: string, data: Buffer }[]) {
      const target = join(unpacked, entry.name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
    }
    const version = (JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8')) as { version: string }).version
    assert.equal(version, manifest.version, 'the ZIP and the manifest must agree on the version')

    files = await serveFixtures()
    browser = await launchBrowser(mkdtempSync(join(tmpdir(), 'dsh-connector-pair-profile-')), unpacked)
    await pairWith(browser, `ws://127.0.0.1:${brokerPort}`, code)
    assert.equal(await extensionConnected(browser), true)
  })

  it('performs one action end to end through the installed tool layer, with nothing imported from the source tree', { timeout: 120000, skip: skipReason }, async () => {
    const libUrl = pathToFileURL(join(installed, 'lib') + '/')
    const [agentModule, toolsModule, authModule, pathsModule] = await Promise.all([
      import(new URL('agent-client.js', libUrl).href),
      import(new URL('dsh/tools.js', libUrl).href),
      import(new URL('auth.js', libUrl).href),
      import(new URL('paths.js', libUrl).href),
    ]) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]
    lib = {
      AgentClient: agentModule['AgentClient'] as InstalledLib['AgentClient'],
      registerBrowserTools: toolsModule['registerBrowserTools'] as InstalledLib['registerBrowserTools'],
      loadOrCreateCredentials: authModule['loadOrCreateCredentials'] as InstalledLib['loadOrCreateCredentials'],
      credentialsPath: pathsModule['credentialsPath'] as InstalledLib['credentialsPath'],
      brokerStatePath: pathsModule['brokerStatePath'] as InstalledLib['brokerStatePath'],
    }

    // The plugin reads the same credentials file the broker created; so does this.
    const secret = lib.loadOrCreateCredentials(lib.credentialsPath(home)).secret
    agent = new lib.AgentClient({
      url: `ws://127.0.0.1:${brokerPort}`, secret, version: manifest.version, profileId: PROFILE, name: 'DeepSeek Harness (released)',
    })
    agent.start()
    await waitFor('the installed agent client to pair with the packaged broker', () => agent.connected)
    agent.addSession(SESSION, 'Released session')
    await settle()

    lib.registerBrowserTools({ tools: { register(tool: RegisteredTool) { tools.set(tool.name, tool); return () => {} } } }, { client: agent })
    assert.equal(tools.size, 20, 'the installed tool layer must register every tool')

    const page = await browser.context.newPage()
    await page.goto(files.url('page-a.html'))
    const tabId = await tabIdFor(browser, files.url('page-a.html'))
    const attached = await attachTab(browser, SCOPE, tabId)
    assert.equal(attached.ok, true, attached.error ?? 'attach failed')

    const snapshot = await runTool('browser_snapshot') as { url: string, elements: { ref: string, name: string }[] }
    assert.equal(snapshot.url, files.url('page-a.html'))
    const button = snapshot.elements.find((element) => element.name === 'Click me')
    assert.ok(button, `page-a's button must be listed; names were ${JSON.stringify(snapshot.elements.map((element) => element.name))}`)
    await runTool('browser_click', { ref: button.ref })
    assert.equal(await page.evaluate(() => document.getElementById('outcome')?.textContent), 'clicked 1', 'the page itself must show the click happened')
  })

  it('survives its broker process being killed: ownership comes back from the state file and the next action needs no re-attachment', { timeout: 120000, skip: skipReason }, async () => {
    const statePath = lib.brokerStatePath(home)
    assert.ok(existsSync(statePath), 'the broker process must have persisted ownership')
    const before = readFileSync(statePath, 'utf8')
    const owners = (JSON.parse(before) as { scopeOwners: Record<string, string> }).scopeOwners
    const identity = (await panelState())['identity'] as { browserId: string }
    const ownerKey = Object.keys(owners).find((key) => key.includes(PROFILE) && key.includes(SESSION))
    assert.ok(ownerKey, `the state file must name the scope; it holds ${JSON.stringify(Object.keys(owners))}`)
    assert.equal(owners[ownerKey], identity.browserId, 'the scope must be owned by this Chrome profile')

    await killBrokerProcess()
    assert.equal(await extensionConnected(browser), false, 'the extension must notice its broker is gone')

    await startBrokerProcess()
    assert.equal(readFileSync(statePath, 'utf8'), before, 'the new process must start from the same ownership file, unchanged')
    // Both sides reconnect on their own, within their bounded backoff.
    await waitFor('the extension to reconnect to the new broker process', () => extensionConnected(browser), 40000)
    await waitFor('the installed agent client to reconnect', () => agent.connected, 40000)
    await settle(300)

    const settings = (await panelState())['settings'] as { pairingCode: string }
    assert.equal(settings.pairingCode, code, 'no re-pairing was needed')
    const listed = await runTool('browser_list_tabs') as { tabs: { url: string }[] }
    assert.equal(listed.tabs.length, 1, 'the session still owns exactly its tab')
    assert.equal(listed.tabs[0]?.url, files.url('page-a.html'))
    const snapshot = await runTool('browser_snapshot') as { url: string }
    assert.equal(snapshot.url, files.url('page-a.html'))
    assert.match(readFileSync(brokerLog, 'utf8'), /listening on ws:\/\/127\.0\.0\.1:/, 'the broker log must record both starts')
    assert.equal((readFileSync(brokerLog, 'utf8').match(/listening on/g) ?? []).length, 2, 'two starts of the broker process')
  })
})
