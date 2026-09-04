/**
 * The broker's process entry point.
 *
 * Started detached by the installer and, when it is missing, by a plugin instance. It is a separate
 * process because it must outlive any one DeepSeek Harness process: `dsh --profile headless "task"`
 * exits when the task ends, while pairing, browser identity, and tab ownership have to persist
 * (ADR 0001).
 *
 * @module @corsen-ai/dsh-browser-connector/broker-main
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOrCreateCredentials, pairingCode } from './auth.ts'
import { startBroker } from './broker-server.ts'
import { brokerLogPath, brokerStatePath, credentialsPath } from './paths.ts'
import { resolveDshHome } from './dsh/profile.ts'
import { DEFAULT_BROKER_PORT } from './protocol.ts'
import { fileStateStore } from './state-store.ts'

/** This broker's semantic version, checked against every peer's handshake. */
export const BROKER_VERSION = '0.1.0'

/** What the command line asked for. */
interface Options {
  readonly home: string
  readonly port: number
  readonly showPairingCode: boolean
  readonly help: boolean
}

/**
 * Read one named value from an argument list.
 * @param argv - the arguments.
 * @param flag - the flag to find, including its leading dashes.
 * @returns the value, or `undefined`.
 */
function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1]
  const inline = argv.find((entry) => entry.startsWith(`${flag}=`))
  return inline === undefined ? undefined : inline.slice(flag.length + 1)
}

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the resolved options.
 * @throws when `--port` is not a usable port, so a typo cannot silently bind elsewhere.
 */
export function parseOptions(argv: readonly string[]): Options {
  const rawPort = value(argv, '--port')
  const port = rawPort === undefined ? DEFAULT_BROKER_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a port number, not ${JSON.stringify(rawPort)}`)
  }
  return {
    home: value(argv, '--home') ?? resolveDshHome(),
    port,
    showPairingCode: argv.includes('--pairing-code'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

/** The usage text. */
const USAGE = `DeepSeek Harness Connector broker ${BROKER_VERSION} (by Corsen AI)

Usage:
  dsh-connector-broker [--home <dir>] [--port <n>]
  dsh-connector-broker --pairing-code [--home <dir>]

Options:
  --home <dir>     DeepSeek Harness home. Defaults to $DSH_HOME or the platform default.
  --port <n>       Loopback port to own. Defaults to ${DEFAULT_BROKER_PORT}.
  --pairing-code   Print the pairing code for this home and exit.
  --help, -h       Show this message.

The broker listens only on loopback and never accepts a connection that cannot prove the shared
pairing secret. This is an unofficial community project by Corsen AI, not endorsed by DeepSeek.
`

/**
 * Run the broker until the process is stopped.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: Options
  try {
    options = parseOptions(argv)
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const credentials = loadOrCreateCredentials(credentialsPath(options.home))
  if (options.showPairingCode) {
    process.stdout.write(`${pairingCode(credentials.secret)}\n`)
    return 0
  }

  const logFile = brokerLogPath(options.home)
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
  const log = (line: string): void => {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
  }

  let running: Awaited<ReturnType<typeof startBroker>>
  try {
    running = await startBroker({
      secret: credentials.secret,
      version: BROKER_VERSION,
      port: options.port,
      store: fileStateStore(brokerStatePath(options.home), log),
      log,
    })
  } catch (cause) {
    const message = (cause as Error).message
    log(`failed to start: ${message}`)
    process.stderr.write(`${message}\n`)
    return 1
  }

  const stop = (signal: string): void => {
    log(`stopping on ${signal}`)
    void running.close().then(() => { process.exit(0) })
  }
  process.on('SIGINT', () => { stop('SIGINT') })
  process.on('SIGTERM', () => { stop('SIGTERM') })

  // Resolve only when the process is signalled: the broker's job is to keep listening.
  await new Promise<never>(() => {})
  return 0
}

/**
 * Run only when this module is the process entry.
 *
 * `pathToFileURL` is what makes the comparison correct on Windows, where the argument is a drive
 * path rather than a URL. Guarding it lets tests import {@link main} and {@link parseOptions}
 * without starting a server.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
