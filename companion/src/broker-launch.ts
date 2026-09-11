/**
 * Starting the broker from a plugin instance when none is listening.
 *
 * ADR 0001 makes the broker a detached process with its own lifecycle, and the installers start
 * it; a user who installed with `dsh plugin add` alone, or whose broker stopped, would otherwise
 * have to start it by hand before any DeepSeek Harness process could reach the browser. So a
 * plugin instance that finds nothing listening starts one: the same entry the installers run,
 * detached, with its standard error kept beside the broker's own log. A launch lock keeps several
 * DeepSeek Harness processes starting together — `dsh web` and a headless task, say — from each
 * starting a broker; the broker itself refuses a held port, so a duplicate is harmless but noisy.
 *
 * @module @corsen-ai/dsh-browser-connector/broker-launch
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brokerLaunchLockPath, brokerStderrPath, connectorDir } from './paths.ts'

/** How long a launch lock stands before another process may take it. */
const LAUNCH_LOCK_MS = 15_000

/** The subset of `child_process.spawn` this module uses, so tests can supply a fake. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean, stdio: (string | number)[], windowsHide: boolean, env?: NodeJS.ProcessEnv },
) => { pid?: number | undefined, unref(): void, on?: (event: string, listener: (...args: unknown[]) => void) => unknown }

/** What a launch needs. */
export interface LaunchOptions {
  /** The DeepSeek Harness home the broker serves. */
  readonly home: string
  /** The loopback port it must own. */
  readonly port: number
  /** The broker entry file; defaults to the one beside this module. */
  readonly entry?: string
  /** The Node executable; defaults to this process's. */
  readonly execPath?: string
  /** Injected for tests. */
  readonly spawn?: SpawnLike
  /** Injected for tests. */
  readonly now?: () => number
  /** Injected for tests: whether a process id is alive. */
  readonly alive?: (pid: number) => boolean
}

/** What happened. */
export interface LaunchResult {
  /** Whether this call started a broker process. */
  readonly started: boolean
  /** The new process's id, when started. */
  readonly pid?: number
  /** Why nothing was started, otherwise. */
  readonly reason?: string
}

/**
 * The broker's entry file beside this module: the compiled `broker-main.js` in a published
 * package, the TypeScript source when run from the tree.
 * @returns the absolute path.
 */
export function brokerEntryPath(): string {
  const compiled = fileURLToPath(new URL('./broker-main.js', import.meta.url))
  if (existsSync(compiled)) return compiled
  return fileURLToPath(new URL('./broker-main.ts', import.meta.url))
}

/**
 * Whether a process id names a live process.
 * @param pid - the id.
 * @returns whether signal 0 reaches it.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM means it exists and belongs to someone else; only ESRCH means it is gone.
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take the launch lock, unless a fresh one names a live process.
 * @param path - the lock file.
 * @param now - the current time.
 * @param alive - the liveness check.
 * @returns whether the lock is ours.
 */
function takeLaunchLock(path: string, now: number, alive: (pid: number) => boolean): boolean {
  const record = JSON.stringify({ pid: process.pid, at: now })
  try {
    writeFileSync(path, record, { flag: 'wx' })
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  let held: { pid?: number, at?: number } = {}
  try {
    held = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number, at?: number }
  } catch {
    // An unreadable lock is a stale one.
  }
  const fresh = typeof held.at === 'number' && now - held.at < LAUNCH_LOCK_MS
  const holderAlive = typeof held.pid === 'number' && alive(held.pid)
  if (fresh && holderAlive) return false
  writeFileSync(path, record)
  return true
}

/**
 * Start a broker for this home unless another process is already doing so.
 *
 * Never throws for a launch that could not happen: the plugin that calls this must go on loading
 * its tools, and the reason belongs in its log.
 * @param options - what to start and how.
 * @returns whether a process was started.
 */
export function ensureBrokerProcess(options: LaunchOptions): LaunchResult {
  const now = options.now ?? Date.now
  const alive = options.alive ?? processAlive
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike)
  const entry = options.entry ?? brokerEntryPath()
  try {
    mkdirSync(connectorDir(options.home), { recursive: true, mode: 0o700 })
    if (!takeLaunchLock(brokerLaunchLockPath(options.home), now(), alive)) {
      return { started: false, reason: 'another DeepSeek Harness process is starting the broker' }
    }
    // Standard error is kept in a file the broker's own log points at; standard output has nothing
    // a detached process could show anyone.
    const stderr = openSync(brokerStderrPath(options.home), 'a')
    let child: ReturnType<SpawnLike>
    try {
      child = spawn(options.execPath ?? process.execPath, [entry, '--home', options.home, '--port', String(options.port)], {
        detached: true,
        stdio: ['ignore', 'ignore', stderr],
        windowsHide: true,
      })
    } finally {
      closeSync(stderr)
    }
    // A spawn that fails asynchronously (an unrunnable Node, say) must not become an unhandled
    // error inside DeepSeek Harness.
    child.on?.('error', () => {})
    child.unref()
    if (typeof child.pid === 'number') {
      writeFileSync(brokerLaunchLockPath(options.home), JSON.stringify({ pid: child.pid, at: now() }))
    }
    return typeof child.pid === 'number' ? { started: true, pid: child.pid } : { started: true }
  } catch (cause) {
    return { started: false, reason: (cause as Error).message }
  }
}
