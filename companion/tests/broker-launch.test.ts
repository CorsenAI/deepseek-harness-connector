/**
 * Starting the broker from a plugin instance.
 *
 * Two layers. Against a fake `spawn`, the launch lock and the command line: what is started, with
 * which arguments, and when a second process must not start another. Then for real: the actual
 * broker entry started detached into a scratch home, an `AgentClient` first finding nothing and
 * then pairing with the process the launcher started, the pid file the broker wrote, and the
 * process stopped again — the whole of what a user gets from `dsh plugin add` followed by starting
 * DeepSeek Harness.
 * @module
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { AgentClient, type AgentClientStatus } from '../src/agent-client.ts'
import { loadOrCreateCredentials } from '../src/auth.ts'
import { brokerEntryPath, ensureBrokerProcess, type SpawnLike } from '../src/broker-launch.ts'
import { brokerLaunchLockPath, brokerPidPath, brokerStderrPath, credentialsPath } from '../src/paths.ts'

let home: string

/** What the fake spawn recorded. */
interface Spawned { command: string, args: readonly string[], options: { detached: boolean, stdio: (string | number)[], windowsHide: boolean }, unrefed: boolean }

/**
 * A spawn that starts nothing and remembers everything.
 * @param calls - where each call is recorded.
 * @param pid - the id the fake child reports.
 * @returns the fake.
 */
function fakeSpawn(calls: Spawned[], pid = 4242): SpawnLike {
  return (command, args, options) => {
    const record: Spawned = { command, args, options, unrefed: false }
    calls.push(record)
    return { pid, unref: () => { record.unrefed = true }, on: () => undefined }
  }
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

/** @returns the HTTP status the port answers with, or 0 when nothing answers. */
async function answers(port: number): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status
  } catch {
    return 0
  }
}

/**
 * Wait for a condition.
 * @param what - for the failure message.
 * @param check - the condition.
 * @param timeoutMs - how long.
 */
async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

before(() => { home = mkdtempSync(join(tmpdir(), 'dsh-connector-launch-')) })
after(() => { rmSync(home, { recursive: true, force: true }) })

describe('ensureBrokerProcess, against a fake spawn', () => {
  it('starts the broker entry detached, with the home and port, and lets go of it', () => {
    const calls: Spawned[] = []
    const result = ensureBrokerProcess({ home, port: 18790, entry: '/x/broker-main.js', execPath: '/x/node', spawn: fakeSpawn(calls), now: () => 1000 })
    assert.deepEqual(result, { started: true, pid: 4242 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, '/x/node')
    assert.deepEqual(calls[0]!.args, ['/x/broker-main.js', '--home', home, '--port', '18790'])
    assert.equal(calls[0]!.options.detached, true, 'the broker must outlive this process')
    assert.equal(calls[0]!.options.windowsHide, true)
    assert.deepEqual(calls[0]!.options.stdio.slice(0, 2), ['ignore', 'ignore'])
    assert.equal(typeof calls[0]!.options.stdio[2], 'number', 'standard error is kept in a file')
    assert.equal(calls[0]!.unrefed, true, 'the child must not keep DeepSeek Harness alive')
    assert.deepEqual(JSON.parse(readFileSync(brokerLaunchLockPath(home), 'utf8')), { pid: 4242, at: 1000 })
    assert.ok(existsSync(brokerStderrPath(home)))
  })

  it('does not start a second broker while a fresh lock names a live process', () => {
    const calls: Spawned[] = []
    writeFileSync(brokerLaunchLockPath(home), JSON.stringify({ pid: process.pid, at: 5000 }))
    const result = ensureBrokerProcess({ home, port: 18790, entry: '/x/broker-main.js', spawn: fakeSpawn(calls), now: () => 5000 + 2000 })
    assert.equal(result.started, false)
    assert.match(String(result.reason), /another DeepSeek Harness process/)
    assert.equal(calls.length, 0)
  })

  it('takes over a lock that is stale, or whose holder is gone', () => {
    const calls: Spawned[] = []
    writeFileSync(brokerLaunchLockPath(home), JSON.stringify({ pid: process.pid, at: 5000 }))
    assert.equal(ensureBrokerProcess({ home, port: 1, entry: '/x/b.js', spawn: fakeSpawn(calls, 1), now: () => 5000 + 20000 }).started, true, 'stale by time')
    writeFileSync(brokerLaunchLockPath(home), JSON.stringify({ pid: 999999, at: 7000 }))
    assert.equal(ensureBrokerProcess({ home, port: 1, entry: '/x/b.js', spawn: fakeSpawn(calls, 2), now: () => 7000 + 1000, alive: () => false }).started, true, 'holder gone')
    writeFileSync(brokerLaunchLockPath(home), 'not json')
    assert.equal(ensureBrokerProcess({ home, port: 1, entry: '/x/b.js', spawn: fakeSpawn(calls, 3), now: () => 9000 }).started, true, 'unreadable lock')
    assert.equal(calls.length, 3)
  })

  it('reports, rather than throws, when the process cannot be started', () => {
    const failing: SpawnLike = () => { throw new Error('spawn ENOENT') }
    writeFileSync(brokerLaunchLockPath(home), JSON.stringify({ pid: 1, at: 0 }))
    const result = ensureBrokerProcess({ home, port: 1, entry: '/x/b.js', spawn: failing, now: () => 99999, alive: () => false })
    assert.deepEqual(result, { started: false, reason: 'spawn ENOENT' })
  })

  it('finds the broker entry beside itself', () => {
    assert.match(brokerEntryPath(), /broker-main\.(js|ts)$/)
    assert.ok(existsSync(brokerEntryPath()))
  })
})

describe('ensureBrokerProcess, for real', () => {
  let port: number
  let pid: number | undefined

  before(async () => { port = await freePort() })
  after(() => { if (pid !== undefined) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } } })

  it('starts the real broker detached; a client that found nothing then pairs with it; the broker records its pid and stops on request', { timeout: 60000 }, async () => {
    rmSync(brokerLaunchLockPath(home), { force: true })
    const credentials = loadOrCreateCredentials(credentialsPath(home))
    const statuses: AgentClientStatus[] = []
    const client = new AgentClient({
      url: `ws://127.0.0.1:${port}`, secret: credentials.secret, version: '0.1.0', profileId: 'web.launch0000001', name: 'launch test',
      onStatus: (status) => { statuses.push(status) },
    })
    client.start()
    await waitFor('the client to report the port unreachable', () => statuses.includes('unreachable'))
    assert.ok(!statuses.includes('disconnected'), 'nothing was ever connected, so nothing was disconnected')

    const launch = ensureBrokerProcess({ home, port })
    assert.equal(launch.started, true, launch.reason)
    pid = launch.pid
    assert.equal(typeof pid, 'number')
    await waitFor('the started broker to listen', async () => await answers(port) === 426, 20000)
    await waitFor('the client to pair with the started broker', () => client.connected, 30000)
    assert.ok(statuses.includes('connected'))

    // The broker wrote its own pid — the number the installers stop before starting a newer one.
    await waitFor('the pid file', () => existsSync(brokerPidPath(home)))
    assert.equal(readFileSync(brokerPidPath(home), 'utf8').trim(), String(pid))

    client.dispose()
    process.kill(pid as number, 'SIGTERM')
    await waitFor('the broker to stop', async () => await answers(port) === 0, 20000)
    if (process.platform !== 'win32') {
      // A signal Windows delivers as a kill leaves no handler to run; elsewhere the broker removes
      // its own claim on the way out.
      await waitFor('the pid file to be removed', () => !existsSync(brokerPidPath(home)))
    }
    pid = undefined
    assert.equal(readFileSync(join(home, 'connector', 'broker.log'), 'utf8').includes('listening on'), true)
  })
})
