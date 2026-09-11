/**
 * One live turn of a real DeepSeek Harness process, through the released pair (gate Y).
 *
 * Everything that is DeepSeek Harness is real: `dsh --profile headless "<task>"` boots the
 * profile, applies the installed plugin, creates the session, runs the agent loop, executes the
 * tool call the model returns through its own tool machinery — so `exec.agent` is a real session —
 * and prints the model's final message. The one thing that is not a model is the model: DeepSeek
 * Harness's own `@deepseek-ai/dsh-llm-mock-server` answers the provider protocol over real HTTP
 * with a scripted sequence, first a rate limit (which is how the test gets the seconds it needs to
 * attach the tab to the session the process just announced), then a `browser_snapshot` tool call,
 * then a final sentence. What crosses the wire between DeepSeek Harness and the mock is captured,
 * so the assertions read the tool result exactly as the model would have.
 *
 * Needs `dist/`, a real `dsh`, and the mock server installed beside it
 * (`npm install @deepseek-ai/dsh-llm-mock-server@next` in the dsh directory). Without them the
 * suite skips and says so.
 * @module
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { readZip } from '../../scripts/package.mjs'
import {
  attachTab, launchBrowser, pairWith, serveFixtures, settle, tabIdFor, waitFor,
  type FixtureServer, type LaunchedBrowser,
} from './browser.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'dist')

/** The mock server's library entry, as its published types declare it. */
interface MockLlm {
  readonly baseURL: string
  readonly port: number
  readonly requests: readonly { readonly behavior: string, readonly body: unknown, outcome?: string }[]
  close(): Promise<void>
}

/** @returns the directory holding a real `dsh`, or null. */
function findDsh(): string | null {
  const fromEnv = process.env['DSH_BIN_DIR']
  if (fromEnv) return existsSync(join(fromEnv, 'dsh')) ? fromEnv : null
  const lanes = join(homedir(), 'dsh-int')
  if (!existsSync(lanes)) return null
  for (const lane of readdirSync(lanes).sort()) {
    const bin = join(lanes, lane, 'node_modules', '.bin')
    if (existsSync(join(bin, 'dsh')) && existsSync(join(bin, '..', '@deepseek-ai', 'dsh-llm-mock-server'))) return bin
  }
  return null
}

const artifacts = existsSync(DIST) ? readdirSync(DIST) : []
const tgzName = artifacts.find((name) => /^corsen-ai-dsh-browser-connector-.*\.tgz$/.test(name))
const zipName = artifacts.find((name) => /^dsh-browser-connector-extension-.*\.zip$/.test(name))
const dshBin = findDsh()
const mockEntry = dshBin === null ? null : join(dshBin, '..', '@deepseek-ai', 'dsh-llm-mock-server', 'lib', 'index.js')
const skipReason: string | false = (!tgzName || !zipName)
  ? 'dist/ holds no release artifacts; run `node scripts/package.mjs --out dist` first'
  : dshBin === null
    ? 'no real dsh with @deepseek-ai/dsh-llm-mock-server beside it: set DSH_BIN_DIR, or install both under ~/dsh-int/<lane>'
    : mockEntry !== null && !existsSync(mockEntry)
      ? `the mock server package is not installed beside ${dshBin}`
      : false
if (skipReason) process.stdout.write(`live turn: SKIPPED — ${skipReason}\n`)

let home: string
let unpacked: string
let installed: string
let brokerPort: number
let broker: ReturnType<typeof spawn> | null = null
let mock: MockLlm
let files: FixtureServer
let browser: LaunchedBrowser
let transcript: { status: number | null, stdout: string, stderr: string }
let attachedSession: { profileId: string, sessionId: string } | null = null

const TASK = 'Read the page in the attached tab and tell me its title.'
const FINAL = 'The attached tab is titled "Connector fixture A".'

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

/** Run the real dsh CLI through its entry file, the same program on every platform. */
function dsh(args: string[], env: Record<string, string> = {}): { status: number | null, out: string } {
  const entry = join(dshBin as string, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const result = spawnSync(process.execPath, [entry, ...args], {
    env: { ...process.env, DSH_HOME: home, ...env }, encoding: 'utf8', cwd: home, maxBuffer: 16 * 1024 * 1024,
  })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n[spawn] ${result.error.message}` : ''}` }
}

/** @returns the HTTP status the broker port answers with, or 0 when nothing answers. */
async function brokerAnswers(): Promise<number> {
  try { return (await fetch(`http://127.0.0.1:${brokerPort}/`)).status } catch { return 0 }
}

/** @returns the panel's own state. */
async function panelState(): Promise<Record<string, unknown>> {
  return await browser.panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'connector/state' })) as Record<string, unknown>
}

before(async () => {
  if (skipReason || !tgzName || !zipName) return
  home = mkdtempSync(join(tmpdir(), 'dsh-connector-live-home-'))
  unpacked = mkdtempSync(join(tmpdir(), 'dsh-connector-live-ext-'))
  installed = join(home, 'profiles', 'headless', 'node_modules', '@corsen-ai', 'dsh-browser-connector')
  brokerPort = await freePort()

  // The released pair, installed as a user installs it, plus the profile launch that links the
  // runtime's packages beside the profile (see the released-pair suite).
  const added = dsh(['plugin', '--profile', 'headless', 'add', join(DIST, tgzName)])
  assert.equal(added.status, 0, `dsh plugin add failed:\n${added.out}`)

  // DeepSeek Harness's own mock provider, scripted: a rate limit first, so the adapter waits
  // through its retry delay while the tab is attached; then the tool call; then the answer.
  const { startMockLlmServer } = await import(pathToFileURL(mockEntry as string).href) as {
    startMockLlmServer: (options: Record<string, unknown>) => Promise<MockLlm>
  }
  mock = await startMockLlmServer({
    sequence: ['rate_limit', 'tool_call_success', 'success'],
    retryAfterMs: 4000,
    toolName: 'browser_snapshot',
    toolArguments: '{}',
    successText: FINAL,
  })

  // The user's own patch layer: the provider's endpoint, the connector's broker port, and the
  // session-title plugin stopped — it makes a provider request of its own for a title, which would
  // consume a scripted behaviour meant for the agent (seen in the first run of this suite).
  writeFileSync(join(home, 'profiles', 'headless', 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${mock.baseURL}/v1`,
    '    apiKey: mock-key',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: corsen-browser-connector',
    '  config:',
    `    port: ${brokerPort}`,
    '',
  ].join('\n'))

  const child = spawn(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--home', home, '--port', String(brokerPort)], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  })
  broker = child
  await waitFor('the packaged broker process to listen', async () => await brokerAnswers() === 426, 20000)
  const printed = spawnSync(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--pairing-code', '--home', home], { encoding: 'utf8' })
  const code = String(printed.stdout).trim().split('\n').pop() ?? ''

  const bytes = readFileSync(join(DIST, zipName))
  for (const entry of readZip(bytes) as { name: string, data: Buffer }[]) {
    const target = join(unpacked, entry.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
  files = await serveFixtures()
  browser = await launchBrowser(mkdtempSync(join(tmpdir(), 'dsh-connector-live-profile-')), unpacked)
  await pairWith(browser, `ws://127.0.0.1:${brokerPort}`, code)
  const page = await browser.context.newPage()
  await page.goto(files.url('page-a.html'))
}, { timeout: 180000 })

after(async () => {
  if (broker) { broker.kill('SIGKILL'); broker = null }
  await mock?.close()
  await browser?.context.close()
  await files?.close()
  for (const dir of [home, unpacked]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('a live DeepSeek Harness turn through the released pair', () => {
  it('announces its session, is given a tab, reads it through the tool, and answers', { timeout: 180000, skip: skipReason }, async () => {
    const entry = join(dshBin as string, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const run = spawn(process.execPath, [entry, '--profile', 'headless', TASK], {
      env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'mock-key' }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    run.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    run.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const exited = new Promise<number | null>((resolveExit) => { run.once('exit', (status) => { resolveExit(status) }) })

    // The process announces its session to the broker as it boots; the panel sees it through the
    // broker's state, exactly as a user would. Attach the fixture tab to that session — the only
    // one this DeepSeek Harness process has.
    await waitFor('the dsh process to announce its session', async () => {
      const state = await panelState()
      const sessions = ((state['brokerState'] as { sessions?: { profileId: string, sessionId: string }[] } | null)?.sessions) ?? []
      if (sessions.length === 0) return false
      attachedSession = { profileId: sessions[0]!.profileId, sessionId: sessions[0]!.sessionId }
      return true
    }, 60000)
    assert.ok(attachedSession)
    const tabId = await tabIdFor(browser, files.url('page-a.html'))
    const attached = await attachTab(browser, attachedSession, tabId)
    assert.equal(attached.ok, true, attached.error ?? 'attach failed')
    await settle()

    const status = await exited
    transcript = { status, stdout, stderr }
    assert.equal(status, 0, `dsh exited ${status}:\n${stdout}\n${stderr}`)

    // The provider saw the three scripted requests, in order.
    const behaviors = mock.requests.map((request) => request.behavior)
    assert.deepEqual(behaviors, ['rate_limit', 'tool_call_success', 'success'], `unexpected provider traffic: ${JSON.stringify(behaviors)}`)

    // Every agent request offered the twenty browser tools beside DeepSeek Harness's own.
    for (const [index, request] of mock.requests.entries()) {
      const tools = (request.body as { tools?: { function?: { name?: string } }[] }).tools ?? []
      const browserTools = tools.map((tool) => tool.function?.name ?? '').filter((name) => name.startsWith('browser_'))
      assert.equal(browserTools.length, 20, `request ${index} offered ${browserTools.length} browser tools`)
    }

    // The third request carries the whole conversation, including the tool result DeepSeek Harness
    // produced by executing browser_snapshot through the installed plugin: the fixture page, its
    // controls, and the password masked before it left the page.
    const last = mock.requests[2]!.body as { messages: { role: string, content?: unknown, tool_calls?: { function?: { name?: string } }[] }[] }
    const call = last.messages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    assert.ok(call, `no assistant tool call in the final request; messages were ${JSON.stringify(last.messages.map((m) => m.role))}`)
    assert.equal(call.tool_calls?.[0]?.function?.name, 'browser_snapshot')
    const toolMessages = last.messages.filter((message) => message.role === 'tool')
    assert.equal(toolMessages.length, 1, `expected one tool result in the final request; messages were ${JSON.stringify(last.messages).slice(0, 6000)}`)
    const toolResult = typeof toolMessages[0]!.content === 'string' ? toolMessages[0]!.content : JSON.stringify(toolMessages[0]!.content)
    assert.match(toolResult, /Connector fixture A/, 'the tool result must carry the attached page')
    assert.match(toolResult, /button: Click me/, 'the tool result must list the page’s controls')
    assert.match(toolResult, /textbox: Password/, 'the masked field is listed')
    assert.doesNotMatch(toolResult, /hunter2/, 'the password must have been masked before it reached the model')
    assert.doesNotMatch(toolResult, /no attached browser tab/, 'the tool must have reached the attached tab, not refused')

    // And the final message the process printed is the one the provider returned.
    assert.match(stdout, /Connector fixture A/, `stdout was:\n${stdout}`)
    process.stdout.write(`dsh stdout: ${stdout.trim().slice(0, 300)}\n`)
  })

  it('carried a real session identity into the tool call: the session the panel showed is the one the tool ran for', { skip: skipReason }, () => {
    assert.ok(attachedSession, 'the previous case must have attached a session')
    assert.match(attachedSession.sessionId, /^[A-Za-z0-9_.:@-]{1,160}$/)
    // The second request is the one whose answer was the tool call; the tool ran for the session
    // the process announced, or the result above could not have carried the page.
    assert.equal(mock.requests[1]!.behavior, 'tool_call_success')
    assert.equal(transcript.status, 0)
  })
})
