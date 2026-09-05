/**
 * The release ZIP, loaded in a real browser (gate AD).
 *
 * Every other end-to-end test loads `extension/` from the source tree. This one builds the exact
 * bytes `scripts/package.mjs` would ship, unpacks them itself, and runs the core of the vertical
 * slice against that directory. If packaging dropped a file, rewrote a path, or the allowlist and
 * the code disagreed, this is where it shows.
 * @module
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { ACTION } from '../../companion/src/protocol.ts'
import { buildExtensionZip, EXTENSION_ALLOWLIST, readZip } from '../../scripts/package.mjs'
import { attachTab, pairExtension, startHarness, tabIdFor, type Harness } from './harness.ts'

const PROFILE = 'web.pkg000000001'
const SESSION = 'packaged-session'
const SCOPE = { profileId: PROFILE, sessionId: SESSION }

let harness: Harness
let unpacked: string
let zipSha256: string
let zipBytes: number

/**
 * Every file under a directory, as forward-slash relative paths, sorted.
 * @param dir - the directory.
 * @returns the relative paths.
 */
function listFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else found.push(relative(dir, full).split('\\').join('/'))
    }
  }
  walk(dir)
  return found.sort()
}

before(async () => {
  const { zip } = buildExtensionZip() as { zip: Buffer }
  zipSha256 = createHash('sha256').update(zip).digest('hex')
  zipBytes = zip.length

  // Unpack the archive's own bytes — not the source tree — into a fresh directory.
  unpacked = mkdtempSync(join(tmpdir(), 'dsh-connector-packaged-'))
  for (const entry of readZip(zip) as { name: string, data: Buffer }[]) {
    const target = join(unpacked, entry.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }

  harness = await startHarness({ extensionDir: unpacked })
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => {
  await harness?.close()
  if (unpacked) rmSync(unpacked, { recursive: true, force: true })
})

describe('the packaged extension in a real browser', () => {
  it('unpacks to exactly the allowlisted files and nothing else', () => {
    assert.deepEqual(listFiles(unpacked), [...EXTENSION_ALLOWLIST].sort())
    // Recorded so the evidence names the bytes that were tested.
    process.stdout.write(`packaged zip: ${zipBytes} bytes, sha256 ${zipSha256}\n`)
  })

  it('loads, pairs, and reaches an attached tab from the packaged bytes', { timeout: 60000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(harness.pageUrl('page-a.html'))
    const tabId = await tabIdFor(harness, harness.pageUrl('page-a.html'))
    assert.equal((await attachTab(harness, SCOPE, tabId)).ok, true)

    const agent = await harness.agent(PROFILE, [SESSION])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    assert.equal(snapshot['title'], 'Connector fixture A')
    assert.match(String(snapshot['text']), /The quick brown fox/)
  })

  it('masks secrets from the packaged page interface', { timeout: 60000 }, async () => {
    const agent = await harness.agent(PROFILE, [SESSION])
    const serialized = JSON.stringify(await agent.request(SESSION, ACTION.SNAPSHOT, {}))
    for (const secret of ['hunter2-the-real-password', '4111111111111111', 'csrf-token-should-never-appear']) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked from the packaged build`)
    }
  })

  it('clicks, and the page confirms it, from the packaged bytes', { timeout: 60000 }, async () => {
    const page = harness.context.pages().find((candidate) => candidate.url().endsWith('page-a.html'))
    assert.ok(page)
    const agent = await harness.agent(PROFILE, [SESSION])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const button = (snapshot['elements'] as { ref: string, name: string }[]).find((element) => element.name === 'Click me')
    assert.ok(button)
    await agent.request(SESSION, ACTION.CLICK, { ref: button.ref })
    await page.waitForFunction(() => document.getElementById('outcome')?.textContent === 'clicked 1')
  })
})
