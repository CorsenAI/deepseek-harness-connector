/**
 * Performance measurements on representative tasks (gate AH): numbers, not adjectives.
 *
 * Every figure is a wall-clock round trip as the plugin sees it — from `AgentClient.request` to
 * its settlement, through the broker, the extension's service worker, and the page — plus the
 * exact size of the frames that carried the answer, read off the wire by the same relay the
 * injection suite uses. The fixtures are the repository's own: `page-a.html` (a small form),
 * `page-c.html` (the twenty-action fixture), and a generated large page that exhausts the walk
 * budgets. Nothing is compared to any other project; the point is to know what this one costs.
 *
 * Run: `node --experimental-strip-types tests/perf/measure.ts [--runs 30] [--json <file>]`
 * (headed by default; `DSH_E2E_HEADLESS=1` for a machine without a display).
 * @module
 */

import { writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem, arch } from 'node:os'
import { AgentClient } from '../../companion/src/agent-client.ts'
import { ACTION, type ActionKind } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, startHarness, tabIdFor, waitFor, settle, type Harness } from '../e2e/harness.ts'
import { startWiretap, type Wiretap } from '../e2e/wiretap.ts'

const PROFILE = 'web.perf000000001'
const SESSION = 'perf-session'

/** One measured sample. */
interface Sample {
  /** Round trip, milliseconds. */
  readonly ms: number
  /** Bytes of the `action_result` frame the browser sent. */
  readonly resultBytes: number
  /** Bytes of the `action_response` frame the plugin received. */
  readonly responseBytes: number
  /** Whether the page reported a truncated payload. */
  readonly truncated: boolean
}

/** Summary statistics for one task. */
interface Summary {
  readonly task: string
  readonly runs: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly minMs: number
  readonly maxMs: number
  readonly medianResultBytes: number
  readonly maxResultBytes: number
  readonly medianResponseBytes: number
  readonly truncatedRuns: number
}

/**
 * @param values - the samples.
 * @param fraction - the rank, 0.5 for the median.
 * @returns the nearest-rank percentile.
 */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1] ?? 0
}

/**
 * @param html - body markup.
 * @returns a complete document.
 */
function document(html: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>generated</title></head><body>${html}</body></html>`
}

/**
 * A large page: enough text and controls to exhaust every walk budget, the way a long article
 * with a comment section does.
 * @returns the document.
 */
function largePage(): string {
  const parts: string[] = ['<h1>Large page</h1>']
  for (let index = 0; index < 3000; index += 1) {
    parts.push(`<p>Paragraph ${index}: the quick brown fox jumps over the lazy dog while the connector counts every visible word it can reach before its budget ends.</p>`)
    if (index % 10 === 0) parts.push(`<button type="button">Action ${index}</button>`)
    if (index % 25 === 0) parts.push(`<label>Field ${index} <input type="text" value="value ${index}"></label>`)
  }
  parts.push('<p id="end">THE_END_MARKER</p>')
  return document(parts.join('\n'))
}

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] || 30) || 30
const jsonIndex = process.argv.indexOf('--json')
const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined

const harness: Harness = await startHarness({ generatedPages: { 'page-large.html': largePage() } })
const tap: Wiretap = await startWiretap(harness.broker.port)
await pairExtension(harness, tap.url)

/** Open one fixture in a new tab and attach it to the session as its active tab. */
async function open(name: string): Promise<void> {
  const url = harness.pageUrl(name)
  const page = await harness.context.newPage()
  await page.goto(url)
  const tabId = await tabIdFor(harness, url)
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
  if (!attached.ok) throw new Error(attached.error ?? 'attach failed')
}

// The agent goes through the relay too, so both frames of every answer are on the record.
const agent = new AgentClient({ url: tap.url, secret: harness.secret, version: '0.1.0', profileId: PROFILE, name: 'DeepSeek Harness (perf)' })
agent.start()
await waitFor('the agent to pair through the relay', () => agent.connected)
agent.addSession(SESSION, 'Performance session')
await settle()
const summaries: Summary[] = []

/**
 * Measure one task.
 * @param task - a label.
 * @param kind - the action.
 * @param args - its arguments.
 */
async function measure(task: string, kind: ActionKind, args: Record<string, unknown> = {}): Promise<void> {
  const samples: Sample[] = []
  // One warm-up settles the page's layout and the worker's first wake; it is not counted.
  await agent.request(SESSION, kind, args)
  for (let run = 0; run < runs; run += 1) {
    const mark = tap.mark()
    const started = performance.now()
    const result = await agent.request(SESSION, kind, args) as { truncated?: boolean }
    const ms = performance.now() - started
    const frames = tap.since(mark).map((frame) => ({ ...frame, type: (JSON.parse(frame.bytes) as { type: string }).type }))
    const resultFrame = frames.find((frame) => frame.type === 'action_result')
    const responseFrame = frames.find((frame) => frame.type === 'action_response')
    samples.push({
      ms,
      resultBytes: Buffer.byteLength(resultFrame?.bytes ?? '', 'utf8'),
      responseBytes: Buffer.byteLength(responseFrame?.bytes ?? '', 'utf8'),
      truncated: result?.truncated === true,
    })
  }
  const summary: Summary = {
    task,
    runs,
    medianMs: Number(percentile(samples.map((sample) => sample.ms), 0.5).toFixed(1)),
    p95Ms: Number(percentile(samples.map((sample) => sample.ms), 0.95).toFixed(1)),
    minMs: Number(Math.min(...samples.map((sample) => sample.ms)).toFixed(1)),
    maxMs: Number(Math.max(...samples.map((sample) => sample.ms)).toFixed(1)),
    medianResultBytes: percentile(samples.map((sample) => sample.resultBytes), 0.5),
    maxResultBytes: Math.max(...samples.map((sample) => sample.resultBytes)),
    medianResponseBytes: percentile(samples.map((sample) => sample.responseBytes), 0.5),
    truncatedRuns: samples.filter((sample) => sample.truncated).length,
  }
  summaries.push(summary)
  process.stdout.write(`${task}: median ${summary.medianMs} ms, p95 ${summary.p95Ms} ms, result frame ${summary.medianResultBytes} B\n`)
}

// The small form: what a login or a settings page costs.
await open('page-a.html')
await measure('page-a snapshot', ACTION.SNAPSHOT)
await measure('page-a read_text', ACTION.READ_TEXT)
{
  const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
  const button = snapshot.elements.find((element) => element.name === 'Click me')
  if (!button) throw new Error('page-a has no "Click me" button')
  await measure('page-a click', ACTION.CLICK, { ref: button.ref })
}
await measure('page-a current_url', ACTION.CURRENT_URL)

// The twenty-action fixture: a page with a bit of everything.
await open('page-c.html')
await measure('page-c snapshot', ACTION.SNAPSHOT)
await measure('page-c find', ACTION.FIND, { text: 'Fixture' })

// The large page: every budget reached, the payload capped, and the walk deadline's clock reads.
await open('page-large.html')
await measure('page-large snapshot', ACTION.SNAPSHOT)
await measure('page-large read_text', ACTION.READ_TEXT)
await measure('page-large find (last paragraph)', ACTION.FIND, { text: 'THE_END_MARKER' })

// What the wall-clock deadline itself costs: the walk reads the clock once every 256 nodes, so a
// full-budget snapshot reads it at most (6000 + 24000) / 256 times. The price of one read is
// measured in the same page, the same way the walk reads it.
const largeTab = harness.context.pages().find((page) => page.url().endsWith('page-large.html'))
if (!largeTab) throw new Error('the large page is not open')
const clockNs = await largeTab.evaluate(() => {
  const iterations = 1_000_000
  const started = performance.now()
  let sink = 0
  for (let index = 0; index < iterations; index += 1) sink += performance.now()
  const elapsed = performance.now() - started
  return sink > 0 ? (elapsed * 1e6) / iterations : 0
})
const clockReadsPerSnapshot = Math.ceil((6000 + 24000) / 256)
const deadlineCostUs = Number(((clockReadsPerSnapshot * clockNs) / 1000).toFixed(2))
process.stdout.write(`deadline clock: ${clockNs.toFixed(1)} ns per performance.now(), at most ${clockReadsPerSnapshot} reads per full-budget snapshot = ${deadlineCostUs} µs\n`)

const environment = {
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  node: process.version,
  headless: process.env['DSH_E2E_HEADLESS'] === '1',
  runs,
  measuredAt: new Date().toISOString(),
}
const report = { environment, deadline: { clockNsPerRead: Number(clockNs.toFixed(1)), maxReadsPerSnapshot: clockReadsPerSnapshot, costMicroseconds: deadlineCostUs }, tasks: summaries }
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)

process.stdout.write('\n| Task | Runs | Median ms | p95 ms | Min ms | Max ms | Result frame (median B) | Result frame (max B) | Response frame (median B) | Truncated runs |\n')
process.stdout.write('|---|---|---|---|---|---|---|---|---|---|\n')
for (const summary of summaries) {
  process.stdout.write(`| ${summary.task} | ${summary.runs} | ${summary.medianMs} | ${summary.p95Ms} | ${summary.minMs} | ${summary.maxMs} | ${summary.medianResultBytes} | ${summary.maxResultBytes} | ${summary.medianResponseBytes} | ${summary.truncatedRuns} |\n`)
}
process.stdout.write(`\nEnvironment: ${JSON.stringify(environment)}\n`)

agent.dispose()
await tap.close()
await harness.close()
