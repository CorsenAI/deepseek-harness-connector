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
 * Every tool this connector registers, one per protocol action.
 *
 * This list is authoritative rather than descriptive: {@link registerBrowserTools} refuses to
 * finish if the names it actually registered differ from it, so the list, the registrations, and
 * the protocol's action set cannot drift apart without the plugin failing loudly at load.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = Object.freeze([
  'browser_snapshot',
  'browser_read_text',
  'browser_current_url',
  'browser_find',
  'browser_wait',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_scroll',
  'browser_hover',
  'browser_select_option',
  'browser_drag',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_list_tabs',
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
])

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
 * Describe what became of a requested form submission.
 *
 * A submission has three outcomes the model must be able to tell apart: none was asked for, the
 * browser dispatched one, or the browser refused. The middle case is stated for what it is — the
 * form's submit event was dispatched — because that is all the page can observe. It is not a claim
 * that a server received or accepted anything.
 * @param submitted - whether the browser dispatched the form's submit event.
 * @param failed - why it did not, when it did not.
 * @returns a sentence ending in a space, or an empty string when no submission was requested.
 */
function describeSubmission(submitted: boolean | undefined, failed: string | undefined): string {
  if (typeof failed === 'string' && failed !== '') return `The form was not submitted: ${failed}. `
  if (submitted === true) return 'The browser dispatched the form’s submit event; that is not proof a server accepted it. '
  return ''
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
        + 'Navigate this tab to an ordinary web page with browser_navigate, or ask the user to attach a different tab.'
    case 'TAB_GONE':
      return 'The attached tab no longer exists. Ask the user to attach a tab to this session again.'
    case 'CANCELLED':
      return 'The call was abandoned before anything was sent to the browser. Nothing was performed.'
    case 'TIMEOUT':
      return 'The browser did not answer before the deadline. The action had already been sent, so its outcome is unknown: '
        + 'the page may or may not have performed it. Take a fresh snapshot to see the page’s actual state before '
        + 'retrying anything that changes data.'
    case 'INTERRUPTED':
      return 'The connection to the browser was lost while this action was running, so its outcome is unknown: '
        + 'the page may or may not have performed it. Take a fresh snapshot to see the page’s actual state before '
        + 'retrying anything that changes data.'
    case 'UNSUPPORTED_ACTION':
      return `${cause.message}. The installed Chrome extension may be older than this connector.`
    default:
      return cause.message
  }
}

/** Fields every page-level result carries. */
const PAGE_IDENTITY = {
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
} as const

/** One of the session's tabs, as `browser_list_tabs` and the tab actions report it. */
const TAB_SUMMARY = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabRef: { type: 'string', required: true },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    active: { type: 'boolean', required: true },
  },
} as const

/** A page snapshot as the browser returns it. */
const SNAPSHOT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ...PAGE_IDENTITY,
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
  const REF = { type: 'string', required: true, description: 'An element reference from the latest browser_snapshot.' } as const
  const TAB_REF = { type: 'string', required: true, description: 'A tab reference from browser_list_tabs, such as t42.' } as const

  // Every registration is recorded so the end of this function can prove the registered set is
  // exactly BROWSER_TOOL_NAMES and covers every protocol action once.
  const registered: string[] = []
  const register = (definition: Parameters<typeof ctx.tools.register>[0]): void => {
    registered.push(definition.name)
    ctx.tools.register(definition)
  }

  // ---- reading --------------------------------------------------------------

  register(defineTool({
    name: 'browser_snapshot',
    description:
      'Read the browser tab attached to this session as structured text: its URL, title, visible text, '
      + 'and a list of interactive elements each carrying a `ref` you pass to the other browser tools. '
      + 'Password, one-time-code, and payment fields are always masked. '
      + 'Take a fresh snapshot after any navigation or click, because refs from an older snapshot stop working.',
    parameters: {
      maxChars: { type: 'number', description: 'Cap on returned page text. Defaults to a bounded value chosen by the extension.' },
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

  register(defineTool({
    name: 'browser_read_text',
    description:
      'Read only the visible text of the browser tab attached to this session, without the element list. '
      + 'Use it when you need page content but are not about to interact with controls.',
    parameters: { maxChars: { type: 'number', description: 'Cap on returned text.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}\n\n${value.text}${value.truncated ? '\n\n[truncated]' : ''}` }],
    },
    async execute(args, exec) {
      const payload = args.maxChars === undefined ? {} : { maxChars: args.maxChars }
      return await perform(dependencies, exec, ACTION.READ_TEXT, payload) as never
    },
  }))

  register(defineTool({
    name: 'browser_current_url',
    description: 'Report the current URL and title of the browser tab attached to this session.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY } },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}` }],
    },
    async execute(_args, exec) {
      return await perform(dependencies, exec, ACTION.CURRENT_URL, {}) as never
    },
  }))

  register(defineTool({
    name: 'browser_find',
    description:
      'Find visible text in the tab attached to this session and scroll the first match into view. '
      + 'Returns whether it was found, how many times, and a short snippet around the first match.',
    parameters: { text: { type: 'string', required: true, description: 'The text to look for, case-insensitive.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, found: { type: 'boolean', required: true }, count: { type: 'number', required: true }, snippet: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.found ? `Found "${args.text}" ${value.count} time(s). First match: …${value.snippet ?? ''}…` : `"${args.text}" was not found in the visible text of ${value.title}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.FIND, { text: args.text }) as never
    },
  }))

  register(defineTool({
    name: 'browser_wait',
    description:
      'Wait for the tab attached to this session to finish loading and for its content to stop changing, '
      + 'up to a bounded time. Use it after a click or navigation that triggers loading.',
    parameters: { ms: { type: 'number', description: 'Longest wait in milliseconds. Defaults to 5000, capped at 15000.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, settled: { type: 'boolean', required: true }, waitedMs: { type: 'number', required: true }, readyState: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.settled ? `The page settled after ${value.waitedMs} ms.` : `The page was still changing after ${value.waitedMs} ms (readyState ${value.readyState}).` }],
    },
    async execute(args, exec) {
      const payload = args.ms === undefined ? {} : { ms: args.ms }
      return await perform(dependencies, exec, ACTION.WAIT, payload) as never
    },
  }))

  // ---- acting in the page ---------------------------------------------------

  register(defineTool({
    name: 'browser_click',
    description:
      'Click one element in the browser tab attached to this session, addressed by a `ref` from the most '
      + 'recent browser_snapshot. Take a fresh snapshot afterwards, because clicking usually changes the page.',
    parameters: { ref: REF },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, clicked: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Clicked ${value.clicked}. The tab is now at ${value.url}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.CLICK, { ref: args.ref }) as never
    },
  }))

  register(defineTool({
    name: 'browser_type',
    description:
      'Type text into one input, textarea, or editable element in the browser tab attached to this session, '
      + 'addressed by a `ref` from the most recent browser_snapshot. With submit: true the containing form is submitted, '
      + 'and the result says whether the browser actually dispatched that submission. '
      + 'Never type a password, payment card number, or one-time code: those fields are the user’s to fill.',
    parameters: {
      ref: REF,
      text: { type: 'string', required: true, description: 'The text to type.' },
      replace: { type: 'boolean', description: 'Clear the field first. Defaults to false.' },
      submit: { type: 'boolean', description: 'Press Enter and submit the containing form afterwards. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...PAGE_IDENTITY,
          typed: { type: 'string', required: true },
          submitted: { type: 'boolean' },
          submitFailed: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Typed into ${value.typed}. ${describeSubmission(value.submitted, value.submitFailed)}The tab is now at ${value.url}.`,
      }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.TYPE, {
        ref: args.ref, text: args.text, replace: args.replace ?? false, submit: args.submit ?? false,
      }) as never
    },
  }))

  register(defineTool({
    name: 'browser_key',
    description:
      'Press one key in the tab attached to this session: a single character, or Enter, Tab, Escape, Backspace, '
      + 'Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, optionally with '
      + 'modifiers such as Control+a or Shift+Tab. Give a `ref` to focus an element first. Enter in a form field '
      + 'submits the form. To enter text, use browser_type instead.',
    parameters: {
      key: { type: 'string', required: true, description: 'The key, such as Enter or Control+a.' },
      ref: { type: 'string', description: 'An element reference to focus before pressing.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...PAGE_IDENTITY,
          key: { type: 'string', required: true },
          target: { type: 'string', required: true },
          submitted: { type: 'boolean' },
          submitFailed: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Pressed ${value.key} on ${value.target}. ${describeSubmission(value.submitted, value.submitFailed)}The tab is now at ${value.url}.`,
      }],
    },
    async execute(args, exec) {
      const payload: Record<string, unknown> = { key: args.key }
      if (args.ref !== undefined) payload['ref'] = args.ref
      return await perform(dependencies, exec, ACTION.KEY, payload) as never
    },
  }))

  register(defineTool({
    name: 'browser_scroll',
    description:
      'Scroll the tab attached to this session: to an element by `ref`, to the top or bottom with `to`, '
      + 'or by a number of pixels with `dy` (negative scrolls up). Take a fresh snapshot afterwards to see what is now visible.',
    parameters: {
      ref: { type: 'string', description: 'Scroll this element into view.' },
      to: { type: 'string', description: 'Either top or bottom.' },
      dy: { type: 'number', description: 'Pixels to scroll by; negative scrolls up.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, scrollY: { type: 'number', required: true }, scrollHeight: { type: 'number', required: true }, viewportHeight: { type: 'number', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Scrolled to ${value.scrollY} of ${value.scrollHeight} pixels (viewport ${value.viewportHeight}).` }],
    },
    async execute(args, exec) {
      const payload: Record<string, unknown> = {}
      if (args.ref !== undefined) payload['ref'] = args.ref
      if (args.to !== undefined) payload['to'] = args.to
      if (args.dy !== undefined) payload['dy'] = args.dy
      return await perform(dependencies, exec, ACTION.SCROLL, payload) as never
    },
  }))

  register(defineTool({
    name: 'browser_hover',
    description: 'Move the pointer over one element in the tab attached to this session, to reveal a menu or tooltip. Take a fresh snapshot afterwards.',
    parameters: { ref: REF },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, hovered: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Hovered over ${value.hovered}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.HOVER, { ref: args.ref }) as never
    },
  }))

  register(defineTool({
    name: 'browser_select_option',
    description: 'Choose an option in a select control in the tab attached to this session, by option value or by its visible label.',
    parameters: {
      ref: REF,
      value: { type: 'string', description: 'The option value to select.' },
      label: { type: 'string', description: 'The option label to select, when the value is unknown.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, control: { type: 'string', required: true }, selected: { type: 'object', required: true, additionalProperties: true, properties: { value: { type: 'string', required: true }, label: { type: 'string', required: true } } } } },
      render: (_args, value) => [{ type: 'text', text: `Selected "${value.selected.label}" (${value.selected.value}) in ${value.control}.` }],
    },
    async execute(args, exec) {
      const payload: Record<string, unknown> = { ref: args.ref }
      if (args.value !== undefined) payload['value'] = args.value
      if (args.label !== undefined) payload['label'] = args.label
      return await perform(dependencies, exec, ACTION.SELECT_OPTION, payload) as never
    },
  }))

  register(defineTool({
    name: 'browser_drag',
    description: 'Drag one element onto another in the tab attached to this session, using refs from the latest browser_snapshot.',
    parameters: {
      from: { type: 'string', required: true, description: 'The element to drag.' },
      to: { type: 'string', required: true, description: 'The element to drop it on.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...PAGE_IDENTITY, dragged: { type: 'string', required: true }, droppedOn: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Dragged ${value.dragged} onto ${value.droppedOn}.` }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.DRAG, { from: args.from, to: args.to }) as never
    },
  }))

  // ---- navigation -----------------------------------------------------------

  const NAVIGATION_OUTPUT = {
    type: 'object',
    additionalProperties: true,
    properties: { ...TAB_SUMMARY.properties, loaded: { type: 'string', required: true } },
  } as const

  /**
   * Say what a navigation result means, including the one outcome that is not a clean success.
   * @param value - the navigation payload.
   * @returns one sentence the model can act on.
   */
  const describeNavigation = (value: { url: string, title: string, loaded: string }): string => {
    if (value.loaded === 'timeout') {
      return `Now at ${value.url} (${value.title}), but the page had not finished loading within 15 seconds; `
        + 'use browser_wait before reading it.'
    }
    return `Now at ${value.url} (${value.title}); load ${value.loaded}.`
  }

  register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the tab attached to this session to an http or https URL and wait for it to load. Take a fresh snapshot afterwards.',
    parameters: { url: { type: 'string', required: true, description: 'An absolute http or https URL.' } },
    output: {
      schema: NAVIGATION_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: describeNavigation(value) }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.NAVIGATE, { url: args.url }) as never
    },
  }))

  for (const [name, kind, verb] of [
    ['browser_back', ACTION.BACK, 'Go back one page in the history of'],
    ['browser_forward', ACTION.FORWARD, 'Go forward one page in the history of'],
    ['browser_reload', ACTION.RELOAD, 'Reload'],
  ] as const) {
    register(defineTool({
      name,
      description: `${verb} the tab attached to this session and wait for it to load. Take a fresh snapshot afterwards.`,
      parameters: {},
      output: {
        schema: NAVIGATION_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: describeNavigation(value) }],
      },
      async execute(_args, exec) {
        return await perform(dependencies, exec, kind, {}) as never
      },
    }))
  }

  // ---- this session's tabs --------------------------------------------------

  register(defineTool({
    name: 'browser_list_tabs',
    description: 'List the tabs attached to this session — only this session’s tabs — with a `tabRef` for each and which one is active.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { tabs: { type: 'array', required: true, items: TAB_SUMMARY }, activeTabRef: { type: 'string' } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.tabs.length === 0
          ? 'This session has no attached tabs.'
          : value.tabs.map((tab) => `${tab.active ? '* ' : '  '}[${tab.tabRef}] ${tab.title} — ${tab.url}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      return await perform(dependencies, exec, ACTION.LIST_TABS, {}) as never
    },
  }))

  register(defineTool({
    name: 'browser_open_tab',
    description: 'Open a new tab, attach it to this session, and make it this session’s active tab. Optionally load a URL in it.',
    parameters: { url: { type: 'string', description: 'An absolute http or https URL to open. Defaults to a blank page.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...TAB_SUMMARY.properties, opened: { type: 'string', required: true }, attachedTabs: { type: 'number', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Opened ${value.opened} at ${value.url}; this session now has ${value.attachedTabs} tab(s).` }],
    },
    async execute(args, exec) {
      const payload = args.url === undefined ? {} : { url: args.url }
      return await perform(dependencies, exec, ACTION.OPEN_TAB, payload) as never
    },
  }))

  register(defineTool({
    name: 'browser_switch_tab',
    description:
      'Make one of this session’s tabs its active tab, so the other browser tools act there, and bring it to the '
      + 'front of the user’s window when Chrome allows; the result says whether it did. '
      + 'Only tabs from browser_list_tabs can be chosen.',
    parameters: { tabRef: TAB_REF },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ...TAB_SUMMARY.properties, activeTabRef: { type: 'string', required: true }, foregrounded: { type: 'boolean', required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: `Active tab is now ${value.activeTabRef}: ${value.title} — ${value.url}.`
          + (value.foregrounded ? '' : ' Chrome did not bring it to the front; the session still acts there.'),
      }],
    },
    async execute(args, exec) {
      return await perform(dependencies, exec, ACTION.SWITCH_TAB, { tabRef: args.tabRef }) as never
    },
  }))

  register(defineTool({
    name: 'browser_close_tab',
    description: 'Close one of this session’s tabs — the active one when no tabRef is given. Only this session’s own tabs can be closed.',
    parameters: { tabRef: { type: 'string', description: 'A tab reference from browser_list_tabs. Defaults to the active tab.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { closed: { type: 'string', required: true }, remainingTabs: { type: 'number', required: true }, activeTabRef: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Closed ${value.closed}; ${value.remainingTabs} tab(s) remain attached${value.activeTabRef ? `, active ${value.activeTabRef}` : ''}.` }],
    },
    async execute(args, exec) {
      const payload = args.tabRef === undefined ? {} : { tabRef: args.tabRef }
      return await perform(dependencies, exec, ACTION.CLOSE_TAB, payload) as never
    },
  }))

  // Misconfiguration fails loud at load: a tool added without its name here, a name here without its
  // tool, or a protocol action without a tool would each leave the model with a silently wrong
  // tool set, so the plugin refuses to finish applying instead.
  const expected = new Set(BROWSER_TOOL_NAMES)
  const actual = new Set(registered)
  const missing = [...expected].filter((name) => !actual.has(name))
  const unexpected = [...actual].filter((name) => !expected.has(name))
  if (missing.length > 0 || unexpected.length > 0 || registered.length !== expected.size) {
    throw new Error(
      `corsen-browser-connector: registered tools do not match BROWSER_TOOL_NAMES `
      + `(missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}; `
      + `registered ${registered.length}, expected ${expected.size})`,
    )
  }
  if (expected.size !== Object.keys(ACTION).length) {
    throw new Error(
      `corsen-browser-connector: ${expected.size} tools for ${Object.keys(ACTION).length} protocol actions; `
      + 'every action needs exactly one tool',
    )
  }
}
