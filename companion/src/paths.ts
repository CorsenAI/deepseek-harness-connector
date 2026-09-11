/**
 * Where the connector keeps its local state inside the DeepSeek Harness home.
 *
 * Everything lives under one `connector/` directory so an uninstall is a single removal and so
 * nothing this project writes can be confused with DeepSeek Harness's own files.
 *
 * @module @corsen-ai/dsh-browser-connector/paths
 */

import { join } from 'node:path'
import { PROTOCOL_VERSION } from './protocol.ts'

/** The connector's directory inside one DeepSeek Harness home. */
export function connectorDir(home: string): string {
  return join(home, 'connector')
}

/**
 * The pairing secret file.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function credentialsPath(home: string): string {
  return join(connectorDir(home), 'credentials.json')
}

/**
 * The broker's persisted scope ownership.
 *
 * The protocol generation is in the filename so an older broker left running by a previous install
 * can never write the current router's ownership state.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function brokerStatePath(home: string): string {
  return join(connectorDir(home), `broker-state-v${PROTOCOL_VERSION}.json`)
}

/**
 * The broker's log file.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function brokerLogPath(home: string): string {
  return join(connectorDir(home), 'broker.log')
}

/**
 * The running broker's process id, written by the broker itself once it listens and removed when
 * it stops on a signal. The installers read it to stop a previous broker before starting a new
 * one.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function brokerPidPath(home: string): string {
  return join(connectorDir(home), 'broker.pid')
}

/**
 * The launch lock a plugin instance takes while it starts a broker, so several DeepSeek Harness
 * processes starting at once do not each start one.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function brokerLaunchLockPath(home: string): string {
  return join(connectorDir(home), 'broker.launch.json')
}

/**
 * Where a broker started by a plugin instance keeps its standard error, for the reason a broker
 * that died before it could write its own log leaves nowhere else.
 * @param home - the DeepSeek Harness home.
 * @returns the absolute path.
 */
export function brokerStderrPath(home: string): string {
  return join(connectorDir(home), 'broker.stderr.log')
}
