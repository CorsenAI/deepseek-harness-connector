/**
 * The model-facing browser tools, defined against the DeepSeek Harness tool contract (ADR 0005).
 *
 * Every tool resolves its calling session from `exec.agent` and fails when there is none. A tool
 * that could not identify its session performs no browser work at all: there is no fallback target,
 * and guessing one is the exact failure this connector exists to prevent.
 *
 * @module @corsen-ai/dsh-browser-connector/dsh/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgentClient } from '../agent-client.ts'
import { BrowserActionError } from '../agent-client.ts'
import { ACTION, type ActionKind } from '../protocol.ts'
import { resolveSession, sessionFailureMessage } from './session-api.ts'

/** What a tool needs to reach the browser. */
export interface ToolDependencies {
  /** The broker client for this DeepSeek Harness process. */
  readonly client: AgentClient
}

/**
 * Route one action to the calling session's bound tab.
 *
 * @param dependencies - the broker client.
 * @param exec - the DeepSeek Harness execution context.
 * @param kind - the action kind.
 * @param args - the action arguments.
 * @returns the browser's canonical payload.
 * @throws when the call has no session, the session has no attached tab, or the browser failed.
 */
async function perform(
  dependencies: ToolDependencies,
  exec: ToolRunContext,
  kind: ActionKind,
  args: Record<string, unknown>,
): Promise<unknown> {
  const resolution = resolveSession(exec)
  if (!resolution.ok) throw new Error(sessionFailureMessage(resolution.failure))
  try {
    return await dependencies.client.request(resolution.sessionId, kind, args, exec.signal)
  } catch (cause) {
    // The wire's typed code is turned into one model-facing sentence that says what to do next. A
    // model told only "failed" retries the same call; a model told the session has no attached tab
    // stops and asks the user.
    if (cause instanceof BrowserActionError) throw new Error(explain(cause))
    throw cause
  }
}

/**
 * Turn a typed transport failure into a model-facing explanation.
 * @param cause - the failure.
 * @returns one sentence naming the cause and what would resolve it.
 */
function explain(cause: BrowserActionError): string {
  switch (cause.code) {
    case 'NO_BINDING':
      return 'This DeepSeek Harness session has no attached browser tab. '
        + 'Ask the user to open the DeepSeek Harness Connector panel in Chrome, select this session, and attach a tab. '
        + 'No browser action was performed.'
    case 'NO_BROWSER':
      return 'The Chrome profile holding this session is not connected to the connector. '
        + 'Ask the user to open Chrome and check the connector panel. No browser action was performed.'
    case 'BINDING_CHANGED':
      return 'The tab attached to this session changed while the action was running, so its result was discarded. '
        + 'Take a fresh snapshot before acting again.'
    case 'STALE_REF':
      return 'That element reference is from an earlier snapshot and no longer identifies an element. '
        + 'Take a fresh snapshot and use a reference from it.'
    case 'RESTRICTED_PAGE':
      return 'Chrome does not allow extensions to act on this page (for example a chrome:// page or the Web Store). '
        + 'Ask the user to attach an ordinary web page instead.'
    case 'TAB_GONE':
      return 'The attached tab no longer exists. Ask the user to attach a tab to this session again.'
    case 'TIMEOUT':
      return 'The browser did not finish the action in time. The page may still be loading.'
    case 'UNSUPPORTED_ACTION':
      return `${cause.message}. The installed Chrome extension may be older than this connector.`
    default:
      return cause.message
  }
}

/** A page snapshot as the browser returns it. */
const SNAPSHOT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    text: { type: 'string', required: true },
    elements: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ref: { type: 'string', required: true },
          role: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
    },
    truncated: { type: 'boolean', required: true },
  },
} as const

/**
 * Register every browser tool this connector provides.
 *
 * Registration is effect-based in DeepSeek Harness: disposing the plugin fiber unregisters each
 * tool, so an unloaded connector leaves no tool the model can still call.
 * @param ctx - the Cordis context, which must have `tools` injected.
 * @param dependencies - the broker client.
 */
export function registerBrowserTools(ctx: Context, dependencies: ToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description:
      'Read the browser tab attached to this session as structured text: its URL, title, visible text, '
      + 'and a list of interactive elements each carrying a `ref` you pass to the other browser tools. '
      + 'Password, one-time-code, and payment fields are always masked. '
      + 'Take a fresh snapshot after any navigation or click, because refs from an older snapshot stop working.',
    parameters: {
      maxChars: {
        type: 'number',
        description: 'Cap on returned page text. Defaults to a bounded value chosen by the extension.',
      },
    },
    output: {
      schema: SNAPSHOT_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\n\n${value.text}${value.truncated ? '\n\n[page text truncated]' : ''}\n\n`
          + value.elements.map((element) => `[${element.ref}] ${element.role}: ${element.name}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const payload = args.maxChars === undefined ? {} : { maxChars: args.maxChars }
      return await perform(dependencies, exec, ACTION.SNAPSHOT, payload) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_read_text',
    description:
      'Read only the visible text of the browser tab attached to this session, without the element list. '
      + 'Use it when you need page content but are not about to interact with controls.',
    parameters: {
      maxChars: { type: 'number', description: 'Cap on returned text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\n\n${value.text}${value.truncated ? '\n\n[truncated]' : ''}`,
      }],
    },
    async execute(args, exec) {
      const payload = args.maxChars === undefined ? {} : { maxChars: args.maxChars }
      return await perform(dependencies, exec, ACTION.READ_TEXT, payload) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description:
      'Click one element in the browser tab attached to this session, addressed by a `ref` from the most '
      + 'recent browser_snapshot. Take a fresh snapshot afterwards, because clicking usually changes the page.',
    parameters: {
      ref: { type: 'string', required: true, description: 'An element reference from the latest browser_snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          clicked: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Clicked ${value.clicked}. The tab is now at ${value.url}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.CLICK, { ref: args.ref }) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description:
      'Type text into one input, textarea, or editable element in the browser tab attached to this session, '
      + 'addressed by a `ref` from the most recent browser_snapshot. '
      + 'Never type a password, payment card number, or one-time code: those fields are the user’s to fill.',
    parameters: {
      ref: { type: 'string', required: true, description: 'An element reference from the latest browser_snapshot.' },
      text: { type: 'string', required: true, description: 'The text to type.' },
      replace: { type: 'boolean', description: 'Clear the field first. Defaults to false.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          typed: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Typed into ${value.typed}. The tab is now at ${value.url}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.TYPE, {
        ref: args.ref,
        text: args.text,
        replace: args.replace ?? false,
        submit: args.submit ?? false,
      }) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_current_url',
    description: 'Report the current URL of the browser tab attached to this session.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}` }],
    },
    async execute(_args, exec) {
      return await perform(dependencies, exec, ACTION.CURRENT_URL, {}) as never
    },
  }))
}
