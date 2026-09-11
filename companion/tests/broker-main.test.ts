/**
 * The broker process entry, started the way installers and users start it.
 *
 * `broker-main` runs `main()` only when it is the file Node was told to run. That guard once
 * compared the module's URL — which Node reports through every resolved symlink — with the typed
 * path, so on macOS a broker started under `/var` or `/tmp` (links into `/private`) exited 0 in
 * silence: no listener, no pairing code, no error. The cases here start the real entry through a
 * symlinked directory and through the direct path, and read what the process actually did.
 * @module
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { parseOptions } from '../src/broker-main.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const CODE = /^[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}$/

let scratch: string
let linked: string

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-connector-entry-'))
  linked = join(scratch, 'linked-src')
  // Windows needs a junction for a directory link without special privileges.
  symlinkSync(SRC, linked, process.platform === 'win32' ? 'junction' : 'dir')
})

after(() => { rmSync(scratch, { recursive: true, force: true }) })

/**
 * Start the entry in `--pairing-code` mode, which runs `main()` to completion without a server.
 * @param entry - the path to hand Node.
 * @returns exit status and output.
 */
function startEntry(entry: string): { status: number | null, stdout: string, stderr: string } {
  const home = mkdtempSync(join(scratch, 'home-'))
  const result = spawnSync(process.execPath, ['--experimental-strip-types', entry, '--pairing-code', '--home', home], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the broker process entry', () => {
  it('runs main when started through the direct path', () => {
    const run = startEntry(join(SRC, 'broker-main.ts'))
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout.trim(), CODE, `expected a pairing code, got ${JSON.stringify(run.stdout)}`)
  })

  it('runs main when started through a symlinked directory, as every /var and /tmp path is on macOS', () => {
    const run = startEntry(join(linked, 'broker-main.ts'))
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout.trim(), CODE, `the entry did nothing through the link: stdout ${JSON.stringify(run.stdout)}`)
  })

  it('refuses a port that is not a port, before touching anything', () => {
    assert.throws(() => parseOptions(['--port', 'eighty']), /--port must be a port number/)
    assert.equal(parseOptions(['--port', '0']).port, 0)
  })

  it('says the port is taken, in one sentence and in its log, instead of crashing with a stack trace', async () => {
    // Something already holds the port — another broker, or anything else.
    const holder = createServer()
    await new Promise<void>((resolve) => { holder.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = holder.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const home = mkdtempSync(join(scratch, 'home-'))
    try {
      const result = await new Promise<{ status: number | null, stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--experimental-strip-types', join(SRC, 'broker-main.ts'), '--home', home, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.on('exit', (status) => { resolve({ status, stderr }) })
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /port \d+ is already in use; another broker may still be running/)
      assert.doesNotMatch(result.stderr, /Unhandled 'error' event|at Server\./, 'a held port is an expected condition, not a crash')
      const log = readFileSync(join(home, 'connector', 'broker.log'), 'utf8')
      assert.match(log, /failed to start: the connector broker port \d+ is already in use/)
    } finally {
      await new Promise<void>((resolve) => { holder.close(() => { resolve() }) })
    }
  })
})
