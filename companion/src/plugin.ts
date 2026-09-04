/**
 * The DeepSeek Harness plugin entry point.
 *
 * Installed as a profile bundle with `dsh plugin --profile <name> add @corsen-ai/dsh-browser-connector`
 * (ADR 0002). On apply it verifies the DeepSeek Harness version, connects to the local broker as an
 * `agent` client, announces this process's live sessions, and registers the browser tools.
 *
 * @module @corsen-ai/dsh-browser-connector
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AgentClient } from './agent-client.ts'
import { loadOrCreateCredentials } from './auth.ts'
import { credentialsPath } from './paths.ts'
import { DEFAULT_BROKER_PORT, BROKER_HOST } from './protocol.ts'
import { resolveProfileIdentity } from './dsh/profile.ts'
import { observeSessions } from './dsh/session-api.ts'
import { registerBrowserTools } from './dsh/tools.ts'
import { detectDshVersion, supportedRangeText } from './dsh/version.ts'

/** This connector's semantic version. Kept in step with `package.json` by the release gate. */
export const CONNECTOR_VERSION = '0.1.0'

export const name = 'corsen-browser-connector'

/** The tool registry is the only DeepSeek Harness service this plugin requires. */
export const inject = ['tools']

/** Deployment choices a profile may change from `cordis.yml`. */
export interface Config {
  /**
   * Loopback port the broker owns. Change it only when another program already holds the default,
   * and change it in the Chrome extension's settings to match.
   */
  port: number
  /**
   * The profile name used in this instance's routing identity. Empty means derive it from the
   * installation path, which is correct for a normal `dsh plugin` installation.
   */
  profileName: string
  /**
   * Whether an unsupported DeepSeek Harness version stops the plugin from registering its tools.
   * Leaving this on is what keeps an untested runtime from driving a signed-in browser.
   */
  requireSupportedHarness: boolean
}

/** Schemastery configuration for the browser connector. */
export const Config: z<Config> = z.object({
  port: z.natural().default(DEFAULT_BROKER_PORT),
  profileName: z.string().default(''),
  requireSupportedHarness: z.boolean().default(true),
})

/**
 * Mount the connector into one DeepSeek Harness process.
 *
 * A misconfiguration or an unsupported runtime fails loudly here rather than at the first tool call,
 * because a model that discovers a browser tool must be able to rely on it existing.
 * @param ctx - the Cordis context this plugin was applied with.
 * @param config - the validated profile configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = detectDshVersion()
  if (!runtime.supported) {
    const detail = `${runtime.reason ?? 'unknown DeepSeek Harness version'}; this connector supports ${supportedRangeText()}`
    if (config.requireSupportedHarness) {
      throw new Error(`corsen-browser-connector: ${detail}. `
        + 'Update the connector, or set requireSupportedHarness: false in cordis.yml to run it anyway.')
    }
    ctx.logger?.warn?.(`corsen-browser-connector: ${detail}. Running anyway because requireSupportedHarness is false.`)
  }

  const identity = resolveProfileIdentity({ configuredName: config.profileName || undefined })
  const credentials = loadOrCreateCredentials(credentialsPath(identity.home))

  const client = new AgentClient({
    url: `ws://${BROKER_HOST}:${config.port}`,
    secret: credentials.secret,
    version: CONNECTOR_VERSION,
    profileId: identity.profileId,
    name: `DeepSeek Harness (${identity.profileName})`,
    onStatus: (status, detail) => {
      const line = `corsen-browser-connector: ${status} (${detail})`
      if (status === 'refused') ctx.logger?.warn?.(line)
      else ctx.logger?.debug?.(line)
    },
  })

  // Registration is an effect: disposing the plugin fiber closes the broker connection, so an
  // unloaded connector leaves no socket and no tool the model can still call.
  ctx.effect(() => {
    client.start()
    return () => { client.dispose() }
  })

  observeSessions(ctx, {
    onStart: (session) => { client.addSession(session.sessionId, session.title) },
    onEnd: (sessionId) => { client.removeSession(sessionId) },
  })

  registerBrowserTools(ctx, { client })
}
