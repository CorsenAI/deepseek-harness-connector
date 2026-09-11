/**
 * One live turn of a real DeepSeek Harness process, through the released pair (gate Y).
 *
 * Everything that is DeepSeek Harness is real: `dsh --profile headless "<task>"` boots the
 * profile, applies the installed plugin, creates the session, runs the agent loop, executes the
 * tool call the model returns through its own tool machinery — so `exec.agent` is a real session —
 * and prints the model's final message. The one thing that is not a model is the model: DeepSeek
 * Harness's own `@deepseek-ai/dsh-llm-mock-server` answers the provider protocol over real HTTP
 * with a scripted sequence, first a rate limit (which is how the test gets the seconds it needs to
 * attach the tab to the session the process just announced), then one tool call, then a final
 * sentence. Three turns are run, each in its own DeepSeek Harness process with its own scripted
 * provider: `browser_snapshot`; `browser_screenshot` for a model that accepts images; and
 * `browser_screenshot` for a text-only model. What crosses the wire between DeepSeek Harness and
 * the mock is captured, so the assertions read the tool result exactly as the model would have —
 * including whether the screenshot reached it as pixels or as the placeholder DeepSeek Harness
 * substitutes for a model that cannot see.
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
import { jpegDimensions } from './jpeg.ts'
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
let profile: string
let installed: string
let brokerPort: number
let broker: ReturnType<typeof spawn> | null = null
let startMock: (options: Record<string, unknown>) => Promise<MockLlm>
let files: FixtureServer
let browser: LaunchedBrowser
let code: string

/** What one turn produced. */
interface Turn {
  readonly mock: MockLlm
  readonly session: { profileId: string, sessionId: string }
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

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

  // DeepSeek Harness's own mock provider; each turn scripts its own instance.
  const loaded = await import(pathToFileURL(mockEntry as string).href) as {
    startMockLlmServer: (options: Record<string, unknown>) => Promise<MockLlm>
  }
  startMock = loaded.startMockLlmServer

  const child = spawn(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--home', home, '--port', String(brokerPort)], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  })
  broker = child
  await waitFor('the packaged broker process to listen', async () => await brokerAnswers() === 426, 20000)
  const printed = spawnSync(process.execPath, [join(installed, 'lib', 'broker-main.js'), '--pairing-code', '--home', home], { encoding: 'utf8' })
  code = String(printed.stdout).trim().split('\n').pop() ?? ''

  const bytes = readFileSync(join(DIST, zipName))
  for (const entry of readZip(bytes) as { name: string, data: Buffer }[]) {
    const target = join(unpacked, entry.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
  files = await serveFixtures()
  profile = mkdtempSync(join(tmpdir(), 'dsh-connector-live-profile-'))
  browser = await launchBrowser(profile, unpacked)
  await pairWith(browser, `ws://127.0.0.1:${brokerPort}`, code)
  const page = await browser.context.newPage()
  await page.goto(files.url('page-a.html'))
}, { timeout: 180000 })

/**
 * Run one scripted turn of a real DeepSeek Harness process.
 *
 * The mock is scripted `rate_limit` (Retry-After 4 s, the window in which the tab is attached to
 * the session the process announced), then the tool call, then a sentence. The user patch layer
 * points the provider at this turn's mock, stops the session-title plugin — it makes a provider
 * request of its own for a title, which consumed a scripted behaviour on the first run of this
 * suite — and sets the connector's broker port.
 * @param toolName - the tool the scripted model calls.
 * @param finalText - the sentence it answers with afterwards.
 * @param model - the catalogue model the profile is told to use; the profile's own default when
 * omitted. What the mock answers does not depend on it, but what DeepSeek Harness sends does: only
 * a model whose catalogue entry accepts images is sent them.
 * @returns what the provider saw and what the process printed.
 */
async function runTurn(toolName: string, finalText: string, model?: string): Promise<Turn> {
  const mock = await startMock({
    sequence: ['rate_limit', 'tool_call_success', 'success'],
    retryAfterMs: 4000,
    toolName,
    toolArguments: '{}',
    successText: finalText,
  })
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
    // A patch entry's config replaces the plugin's config rather than merging into it, so the
    // provider must be restated beside the model.
    ...model === undefined ? [] : ['- id: agent-default-model', '  config:', '    provider: deepseek-official', `    model: ${model}`],
    '',
  ].join('\n'))

  const entry = join(dshBin as string, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const run = spawn(process.execPath, [entry, '--profile', 'headless', TASK], {
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'mock-key' }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  run.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  run.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  // A turn that does not end is a failure with diagnostics, not a hang: the process is killed
  // after two minutes and what it printed is reported.
  let killed = false
  const leash = setTimeout(() => { killed = true; run.kill('SIGKILL') }, 120000)
  const exited = new Promise<number | null>((resolveExit) => { run.once('exit', (status) => { clearTimeout(leash); resolveExit(status) }) })

  // The process announces its session to the broker as it boots; the panel sees it through the
  // broker's state, exactly as a user would. Attach the fixture tab to that session — the only
  // one this DeepSeek Harness process has.
  let session: { profileId: string, sessionId: string } | null = null
  try {
    await waitFor('the dsh process to announce its session', async () => {
      const state = await panelState()
      const sessions = ((state['brokerState'] as { sessions?: { profileId: string, sessionId: string }[] } | null)?.sessions) ?? []
      if (sessions.length === 0) return false
      session = { profileId: sessions[0]!.profileId, sessionId: sessions[0]!.sessionId }
      return true
    }, 60000)
  } catch (cause) {
    // Say what the process did instead, then stop it and its provider so the suite can go on.
    run.kill('SIGKILL')
    await exited
    await mock.close()
    throw new Error(`${(cause as Error).message}; dsh exited ${run.exitCode}; provider saw ${JSON.stringify(mock.requests.map((request) => request.behavior))}; stdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-4000)}`)
  }
  assert.ok(session)
  const tabId = await tabIdFor(browser, files.url('page-a.html'))
  const attached = await attachTab(browser, session, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  await settle()

  const status = await exited
  await mock.close()
  assert.equal(killed, false, `dsh did not finish the turn within two minutes; provider saw ${JSON.stringify(mock.requests.map((request) => request.behavior))}; stderr:\n${stderr.slice(-4000)}`)
  return { mock, session, status, stdout, stderr }
}

after(async () => {
  if (broker) { broker.kill('SIGKILL'); broker = null }
  await browser?.context.close()
  await files?.close()
  for (const dir of [home, unpacked, profile]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** A wire message of the chat-completions request, as the adapter serialises it. */
interface WireMessage {
  role: string
  content?: string | { type: string, text?: string, image_url?: { url: string } }[]
  tool_calls?: { function?: { name?: string } }[]
}

/**
 * The final request of a turn is the whole conversation: system prompt, task, the model's tool
 * call, the tool result, and — for a model that accepts images — the user message the adapter
 * appends to carry a tool result's images.
 * @param turn - a finished turn.
 * @param toolName - the tool the scripted model called.
 * @returns the conversation, checked to hold that tool call and exactly one tool result.
 */
function finalConversation(turn: Turn, toolName: string): { messages: WireMessage[], toolResult: string } {
  const behaviors = turn.mock.requests.map((request) => request.behavior)
  assert.deepEqual(behaviors, ['rate_limit', 'tool_call_success', 'success'], `unexpected provider traffic: ${JSON.stringify(behaviors)}`)
  const messages = (turn.mock.requests[2]!.body as { messages: WireMessage[] }).messages
  const call = messages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
  assert.ok(call, `no assistant tool call in the final request; roles were ${JSON.stringify(messages.map((message) => message.role))}`)
  assert.equal(call.tool_calls?.[0]?.function?.name, toolName)
  const toolMessages = messages.filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 1, `expected one tool result in the final request; messages were ${JSON.stringify(messages).slice(0, 6000)}`)
  const content = toolMessages[0]!.content
  return { messages, toolResult: typeof content === 'string' ? content : JSON.stringify(content) }
}

/**
 * The durable copy DeepSeek Harness's attachment service keeps under the harness home
 * (`attachments/v1/objects/<xx>/<sha256>`), found by the digest prefix the wire text names.
 * @param digestPrefix - leading hex of the attachment's sha256.
 * @returns the stored bytes.
 */
function storedAttachment(digestPrefix: string): Buffer {
  const objects = join(home, 'attachments', 'v1', 'objects')
  assert.ok(existsSync(objects), `no attachment objects under ${home}`)
  const matches = readdirSync(objects, { recursive: true }).map(String).filter((entry) => entry.split(/[\\/]/).pop()!.startsWith(digestPrefix))
  assert.equal(matches.length, 1, `expected one stored object starting ${digestPrefix}; found ${JSON.stringify(matches)}`)
  return readFileSync(join(objects, matches[0]!))
}

describe('a live DeepSeek Harness turn through the released pair', () => {
  it('announces its session, is given a tab, reads it through browser_snapshot, and answers', { timeout: 180000, skip: skipReason }, async () => {
    const turn = await runTurn('browser_snapshot', FINAL)
    assert.equal(turn.status, 0, `dsh exited ${turn.status}:\n${turn.stdout}\n${turn.stderr}`)

    // Every agent request offered the browser tools beside DeepSeek Harness's own.
    for (const [index, request] of turn.mock.requests.entries()) {
      const tools = (request.body as { tools?: { function?: { name?: string } }[] }).tools ?? []
      const browserTools = tools.map((tool) => tool.function?.name ?? '').filter((name) => name.startsWith('browser_'))
      assert.equal(browserTools.length, 21, `request ${index} offered ${browserTools.length} browser tools`)
    }

    // The third request carries the tool result DeepSeek Harness produced by executing
    // browser_snapshot through the installed plugin: the fixture page, its controls, and the
    // password masked before it left the page.
    const { toolResult } = finalConversation(turn, 'browser_snapshot')
    assert.match(toolResult, /Connector fixture A/, 'the tool result must carry the attached page')
    assert.match(toolResult, /button: Click me/, 'the tool result must list the page’s controls')
    assert.match(toolResult, /textbox: Password/, 'the masked field is listed')
    assert.doesNotMatch(toolResult, /hunter2/, 'the password must have been masked before it reached the model')
    assert.doesNotMatch(toolResult, /no attached browser tab/, 'the tool must have reached the attached tab, not refused')

    // The session the panel showed is the one the tool ran for, and the final message the process
    // printed is the one the provider returned.
    assert.match(turn.session.sessionId, /^[A-Za-z0-9_.:@-]{1,160}$/)
    assert.match(turn.stdout, /Connector fixture A/, `stdout was:\n${turn.stdout}`)
    process.stdout.write(`dsh stdout: ${turn.stdout.trim().slice(0, 300)}\n`)
  })

  it('sends a browser_screenshot to a model that accepts images as the pixels themselves', { timeout: 180000, skip: skipReason }, async () => {
    // deepseek-v4-flash-vision-exp is catalogued with image input at every tested DeepSeek
    // Harness version. The adapter tries the provider's files API first; the mock has none, so
    // the image travels inline, base64 in a data URL — which is what the assertion decodes.
    const turn = await runTurn('browser_screenshot', 'I can see the page.', 'deepseek-v4-flash-vision-exp')
    assert.equal(turn.status, 0, `dsh exited ${turn.status}:\n${turn.stdout}\n${turn.stderr}`)
    const { messages, toolResult } = finalConversation(turn, 'browser_screenshot')
    assert.doesNotMatch(toolResult, /no attachment service|No screenshot was taken|could not capture|image omitted/, 'the capture must have been taken, saved and sent')
    assert.match(toolResult, /Screenshot of Connector fixture A \(http:\/\/127\.0\.0\.1:\d+\/page-a\.html\), 1280×720 pixels/, 'the text beside the image names the page')
    assert.match(toolResult, /sha256:[0-9a-f]{8}/, 'DeepSeek Harness names the durable attachment in the text it sends')

    // The adapter carries a tool result's images in a user message right after the tool message.
    const toolIndex = messages.findIndex((message) => message.role === 'tool')
    const carrier = messages[toolIndex + 1]
    assert.ok(carrier && carrier.role === 'user' && Array.isArray(carrier.content), `no image carrier after the tool result; messages were ${JSON.stringify(messages.slice(toolIndex)).slice(0, 1500)}`)
    const images = carrier.content.filter((part) => part.type === 'image_url')
    assert.equal(images.length, 1, `expected one image part; the carrier was ${JSON.stringify(carrier).slice(0, 1500)}`)
    const url = images[0]!.image_url?.url ?? ''
    assert.match(url, /^data:image\/jpeg;base64,/, `the image is inline JPEG; the URL began ${url.slice(0, 40)}`)
    // DeepSeek Harness fits the request copy to its per-request pixel budget (1280×720 came
    // through as 1066×600 here) and says so in the handle text; the bytes on the wire must be
    // exactly the preview it announced, and the same picture.
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    const preview = /request preview (\d+)x(\d+)px/.exec(toolResult)
    assert.ok(preview, `no request preview in the handle text: ${toolResult}`)
    const wireSize = jpegDimensions(bytes)
    assert.deepEqual(wireSize, { width: Number(preview[1]), height: Number(preview[2]) }, 'the pixels the provider received are the preview the text announced')
    assert.ok(Math.abs(wireSize.width / wireSize.height - 1280 / 720) < 0.01, `the preview keeps the capture's proportions; got ${wireSize.width}×${wireSize.height}`)

    // And the durable copy under the harness home is that same JPEG.
    const digest = /sha256:([0-9a-f]{8})/.exec(toolResult)![1]!
    const stored = storedAttachment(digest)
    assert.deepEqual(jpegDimensions(stored), { width: 1280, height: 720 })
    assert.match(turn.stdout, /I can see the page/, `stdout was:\n${turn.stdout}`)
  })

  it('sends a browser_screenshot to a text-only model as DeepSeek Harness’s placeholder naming the saved image', { timeout: 180000, skip: skipReason }, async () => {
    // deepseek-v4-flash is catalogued text-only at every tested version. The capture is still
    // taken and saved; DeepSeek Harness substitutes its placeholder for the pixels and keeps the
    // connector's caption, so the model learns what was captured and where it is kept.
    const turn = await runTurn('browser_screenshot', 'I cannot see, but I know a screenshot was taken.', 'deepseek-v4-flash')
    assert.equal(turn.status, 0, `dsh exited ${turn.status}:\n${turn.stdout}\n${turn.stderr}`)
    const { messages, toolResult } = finalConversation(turn, 'browser_screenshot')
    assert.match(toolResult, /^\[image omitted because this model accepts text only; attachment sha256:[0-9a-f]{8}\]Screenshot of Connector fixture A \(http:\/\/127\.0\.0\.1:\d+\/page-a\.html\), 1280×720 pixels\.$/)
    assert.equal(messages.filter((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')).length, 0, 'no pixels reach a text-only model')
    const digest = /sha256:([0-9a-f]{8})/.exec(toolResult)![1]!
    assert.deepEqual(jpegDimensions(storedAttachment(digest)), { width: 1280, height: 720 }, 'the image was saved even though this model cannot see it')
    assert.match(turn.stdout, /I cannot see/, `stdout was:\n${turn.stdout}`)
  })
})
