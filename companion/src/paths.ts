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
