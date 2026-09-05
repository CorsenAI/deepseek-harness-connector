/**
 * Tool registration and the fail-closed rule, against the real DeepSeek Harness `defineTool`.
 *
 * `defineTool` here is the published implementation, so the schemas, argument validation, and
 * renderers are exercised by DeepSeek Harness's own code rather than by a stand-in. Only the
 * registry and the broker client are substituted, because the point of each case is what happens to
 * one tool call, not how Cordis mounts a plugin.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BrowserActionError } from '../src/agent-client.ts'
import type { AgentClient } from '../src/agent-client.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/dsh/tools.ts'
import { ACTION, ALL_ACTIONS, ERROR } from '../src/protocol.ts'

/** One recorded browser request. */
interface Recorded {
  sessionId: string
  kind: string
  args: Record<string, unknown>
}

/** What `mount()` gives a test. */
interface Mounted {
  tools: Map<string, ToolDefinition>
  requests: Recorded[]
  /** How many times the registry's `register` was called. */
  registrations: number
  /** The disposer each registration returned. */
  disposers: Array<() => void>
  /** How many of those disposers have been called. */
  readonly disposed: number
}

/**
 * The smallest arguments each tool's published schema accepts.
 *
 * `defineTool` validates arguments BEFORE `execute` runs, so a test that wants to reach our own
 * rules must get past DeepSeek Harness's validation first. One generic payload cannot: `browser_key`
 * requires `key`, `browser_drag` requires `from` and `to`. Keyed by tool name, and checked below to
 * cover every registered tool so a new tool cannot be added without a row here.
 */
const MINIMAL_ARGS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  browser_snapshot: {},
  browser_read_text: {},
  browser_current_url: {},
  browser_find: { text: 'needle' },
  browser_wait: {},
  browser_click: { ref: 'e1@1' },
  browser_type: { ref: 'e1@1', text: 'hello' },
  browser_key: { key: 'Enter' },
  browser_scroll: {},
  browser_hover: { ref: 'e1@1' },
  browser_select_option: { ref: 'e1@1' },
  browser_drag: { from: 'e1@1', to: 'e2@1' },
  browser_navigate: { url: 'https://example.test/' },
  browser_back: {},
  browser_forward: {},
  browser_reload: {},
  browser_list_tabs: {},
  browser_open_tab: {},
  browser_switch_tab: { tabRef: 't1' },
  browser_close_tab: {},
})

/**
 * A payload that satisfies every tool's output schema at once.
 *
 * Every output schema is an open object, so one superset value lets a single answer stand in for
 * any tool when the test is about routing rather than rendering.
 */
const UNIVERSAL_PAYLOAD = Object.freeze({
  url: 'https://example.test/', title: 'Example', text: '', elements: [], truncated: false,
  clicked: 'x', typed: 'y', submitted: false, key: 'Enter', target: 'field',
  scrollY: 0, scrollHeight: 0, viewportHeight: 0, hovered: 'h', control: 'c',
  selected: { value: 'v', label: 'l' }, dragged: 'd', droppedOn: 'o', found: false, count: 0,
  settled: true, waitedMs: 0, readyState: 'complete', tabRef: 't1', active: true,
  loaded: 'complete', tabs: [], activeTabRef: 't1', opened: 't1', attachedTabs: 1,
  closed: 't1', remainingTabs: 0, foregrounded: true,
})

/**
 * Register the browser tools against a capturing registry.
 * @param answer - what the broker client returns, or throws.
 * @returns the registered definitions and the requests they made.
 */
function mount(answer: (request: Recorded) => unknown = () => ({ ...UNIVERSAL_PAYLOAD })): Mounted {
  const tools = new Map<string, ToolDefinition>()
  const requests: Recorded[] = []
  const disposers: Array<() => void> = []
  let registrations = 0
  let disposed = 0

  const client = {
    connected: true,
    async request(sessionId: string, kind: string, args: Record<string, unknown>) {
      const recorded = { sessionId, kind, args }
      requests.push(recorded)
      const outcome = answer(recorded)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  } as unknown as AgentClient

  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registrations += 1
        tools.set(definition.name, definition)
        const disposer = (): void => { disposed += 1 }
        disposers.push(disposer)
        return disposer
      },
    },
  } as unknown as Context

  registerBrowserTools(ctx, { client })
  return { tools, requests, disposers, get registrations() { return registrations }, get disposed() { return disposed } }
}

/**
 * A tool execution context with or without a calling agent.
 * @param sessionId - the session, or `undefined` for a call with no agent.
 * @returns something shaped like the execution context DeepSeek Harness supplies.
 */
function execution(sessionId?: string): ToolRunContext {
  const base = { signal: new AbortController().signal }
  return (sessionId === undefined ? base : { ...base, agent: { id: sessionId } }) as unknown as ToolRunContext
}

describe('registration', () => {
  it('registers exactly the authoritative tool list, one tool per protocol action', () => {
    const { tools } = mount()
    assert.deepEqual([...tools.keys()].sort(), [...BROWSER_TOOL_NAMES].sort())
    assert.equal(BROWSER_TOOL_NAMES.length, ALL_ACTIONS.length, 'every protocol action needs exactly one tool')
    assert.equal(new Set(BROWSER_TOOL_NAMES).size, BROWSER_TOOL_NAMES.length, 'tool names must be unique')
  })

  it('has a minimal-arguments row for every tool, so no tool escapes the fail-closed check', () => {
    assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), [...BROWSER_TOOL_NAMES].sort())
  })

  it('returns one disposer per registration, so unloading removes every tool', () => {
    const mounted = mount()
    assert.equal(mounted.registrations, BROWSER_TOOL_NAMES.length)
    assert.equal(mounted.disposers.length, mounted.registrations)
    assert.equal(mounted.disposed, 0)
    for (const dispose of mounted.disposers) dispose()
    assert.equal(mounted.disposed, mounted.registrations)
  })

  it('refuses to finish applying when the registered set drifts from the authoritative list', () => {
    // A registry that silently drops one registration must make the plugin fail loudly rather than
    // leave the model with a tool set nobody declared.
    const ctx = {
      tools: {
        register(definition: ToolDefinition) {
          return definition.name === 'browser_key' ? (() => {}) : (() => {})
        },
      },
    } as unknown as Context
    const dropping = {
      tools: {
        register(definition: ToolDefinition) {
          if (definition.name === 'browser_key') throw new Error('simulated registry refusal')
          return () => {}
        },
      },
    } as unknown as Context
    assert.throws(() => registerBrowserTools(dropping, { client: {} as AgentClient }), /simulated registry refusal/)
    assert.doesNotThrow(() => registerBrowserTools(ctx, { client: {} as AgentClient }))
  })

  it('gives the model a description that says what each tool needs', () => {
    const { tools } = mount()
    for (const [name, definition] of tools) {
      assert.ok(definition.description.length > 40, `${name} needs a usable description`)
      assert.match(definition.description, /session/i, `${name} must say it acts in this session's tab`)
    }
  })

  it('tells the model that refs come from the latest snapshot', () => {
    const { tools } = mount()
    for (const name of ['browser_click', 'browser_type', 'browser_hover', 'browser_drag']) {
      assert.match(String(tools.get(name)?.description), /snapshot/i)
    }
  })

  it('warns the model off typing credentials', () => {
    const { tools } = mount()
    assert.match(String(tools.get('browser_type')?.description), /password|one-time|card/i)
  })

  it('states the switch_tab contract: the scope changes, foregrounding is reported', () => {
    const { tools } = mount()
    const description = String(tools.get('browser_switch_tab')?.description)
    assert.match(description, /active tab/i)
    assert.match(description, /front/i)
    assert.match(description, /whether it did/i)
  })
})

describe('the minimal arguments pass the real schemas', () => {
  it('reaches the broker client exactly once per tool when a session is present', async () => {
    const { tools, requests } = mount()
    for (const name of BROWSER_TOOL_NAMES) {
      const definition = tools.get(name)
      assert.ok(definition, `${name} is not registered`)
      await definition.execute(MINIMAL_ARGS[name], execution('session-present'))
    }
    assert.equal(requests.length, BROWSER_TOOL_NAMES.length, 'every tool must produce exactly one request')
    assert.deepEqual(
      [...new Set(requests.map((entry) => entry.kind))].sort(),
      [...ALL_ACTIONS].sort(),
      'the twenty tools must reach the twenty protocol actions, each exactly once',
    )
  })

  it('is necessary: an invalid payload is refused by DeepSeek Harness before our rules run', async () => {
    // The negative control. Without it, a table that merely happened to pass would prove nothing
    // about the ordering the fail-closed test depends on.
    const { tools, requests } = mount()
    const definition = tools.get('browser_key')
    assert.ok(definition)
    await assert.rejects(
      definition.execute({}, execution('session-present')),
      (cause: unknown) => cause instanceof Error && !/DeepSeek Harness session/.test(cause.message),
      'a missing required argument must fail as a validation error, not as a session error',
    )
    assert.equal(requests.length, 0)
  })
})

describe('fail closed without a session', () => {
  it('refuses every tool that carried no agent, with valid arguments, and contacts no browser', async () => {
    const { tools, requests } = mount()
    for (const name of BROWSER_TOOL_NAMES) {
      const definition = tools.get(name)
      assert.ok(definition, `${name} is not registered`)
      await assert.rejects(
        definition.execute(MINIMAL_ARGS[name], execution()),
        (cause: unknown) => cause instanceof Error && /only run inside a DeepSeek Harness session/.test(cause.message),
        `${name} must refuse a call with no agent for the session reason, not for its arguments`,
      )
    }
    assert.equal(requests.length, 0, 'no browser request may be made without a session')
  })

  it('refuses an agent whose identity cannot be a routing key', async () => {
    const { tools, requests } = mount()
    const definition = tools.get('browser_snapshot')
    assert.ok(definition)
    await assert.rejects(
      definition.execute({}, execution('a session id with spaces')),
      (cause: unknown) => cause instanceof Error && /cannot be used to route/.test(cause.message),
    )
    assert.equal(requests.length, 0)
  })
})

describe('routing on the calling session', () => {
  it('sends each call with the exact session that made it', async () => {
    const { tools, requests } = mount()
    await tools.get('browser_current_url')?.execute({}, execution('session-one'))
    await tools.get('browser_current_url')?.execute({}, execution('session-two'))
    assert.deepEqual(requests.map((entry) => entry.sessionId), ['session-one', 'session-two'])
  })

  it('reads the session per call rather than caching it', async () => {
    const { tools, requests } = mount()
    const definition = tools.get('browser_current_url')
    assert.ok(definition)
    for (const session of ['a', 'b', 'a', 'c']) await definition.execute({}, execution(session))
    assert.deepEqual(requests.map((entry) => entry.sessionId), ['a', 'b', 'a', 'c'])
  })

  it('forwards each tool to its own action kind', async () => {
    const { tools, requests } = mount()
    await tools.get('browser_snapshot')?.execute({}, execution('s'))
    await tools.get('browser_read_text')?.execute({}, execution('s'))
    await tools.get('browser_click')?.execute({ ref: 'e1@1' }, execution('s'))
    await tools.get('browser_type')?.execute({ ref: 'e1@1', text: 'hi' }, execution('s'))
    assert.deepEqual(requests.map((entry) => entry.kind), [
      ACTION.SNAPSHOT, ACTION.READ_TEXT, ACTION.CLICK, ACTION.TYPE,
    ])
  })

  it('defaults the optional typing flags rather than sending undefined', async () => {
    const { tools, requests } = mount()
    await tools.get('browser_type')?.execute({ ref: 'e1@1', text: 'hi' }, execution('s'))
    assert.deepEqual(requests[0]?.args, { ref: 'e1@1', text: 'hi', replace: false, submit: false })
  })

  it('omits an absent cap instead of sending an undefined one', async () => {
    const { tools, requests } = mount()
    await tools.get('browser_snapshot')?.execute({}, execution('s'))
    assert.deepEqual(requests[0]?.args, {})
    await tools.get('browser_snapshot')?.execute({ maxChars: 500 }, execution('s'))
    assert.deepEqual(requests[1]?.args, { maxChars: 500 })
  })
})

describe('explaining a refusal to the model', () => {
  /**
   * @param code - the transport failure to simulate.
   * @returns the message the model would see.
   */
  async function messageFor(code: string): Promise<string> {
    const { tools } = mount(() => new BrowserActionError(code as never, `raw: ${code}`))
    try {
      await tools.get('browser_snapshot')?.execute({}, execution('s'))
    } catch (cause) {
      return (cause as Error).message
    }
    throw new Error(`${code} did not reject`)
  }

  it('tells the model to ask the user to attach a tab', async () => {
    const message = await messageFor(ERROR.NO_BINDING)
    assert.match(message, /attach a tab/i)
    assert.match(message, /No browser action was performed/)
  })

  it('tells the model to take a fresh snapshot after a stale reference', async () => {
    assert.match(await messageFor(ERROR.STALE_REF), /fresh snapshot/i)
  })

  it('explains a binding change rather than inviting a blind retry', async () => {
    assert.match(await messageFor(ERROR.BINDING_CHANGED), /changed while the action was running/i)
  })

  it('explains a restricted page in terms the model can act on', async () => {
    assert.match(await messageFor(ERROR.RESTRICTED_PAGE), /ordinary web page/i)
  })

  it('passes an unrecognised failure through rather than inventing an explanation', async () => {
    assert.match(await messageFor(ERROR.INTERNAL), /raw: INTERNAL/)
  })

  it('says the outcome is unknown, not that nothing happened, when a connection was lost mid-action', async () => {
    const message = await messageFor(ERROR.INTERRUPTED)
    assert.match(message, /may or may not have performed/i)
    assert.match(message, /fresh snapshot/i)
    assert.doesNotMatch(message, /No browser action was performed/)
  })
})

describe('rendering for the model', () => {
  /**
   * @param blocks - rendered content blocks.
   * @returns their text joined.
   */
  const textOf = (blocks: unknown): string => (
    ((blocks ?? []) as { text?: string }[]).map((block) => block.text ?? '').join('')
  )

  it('renders a snapshot as readable text with its element list', () => {
    const { tools } = mount()
    const definition = tools.get('browser_snapshot')
    assert.ok(definition)
    const text = textOf(definition.output.render({}, {
      url: 'https://example.test/',
      title: 'Example',
      text: 'Hello',
      elements: [{ ref: 'e1@1', role: 'button', name: 'Sign in' }],
      truncated: false,
    } as never))
    assert.match(text, /Example/)
    assert.match(text, /\[e1@1\] button: Sign in/)
  })

  it('says plainly when page text was truncated', () => {
    const { tools } = mount()
    const text = textOf(tools.get('browser_snapshot')?.output.render({}, {
      url: 'u', title: 't', text: 'x', elements: [], truncated: true,
    } as never))
    assert.match(text, /truncated/)
  })

  it('never echoes typed text back into the transcript', () => {
    const { tools } = mount()
    const text = textOf(tools.get('browser_type')?.output.render(
      { ref: 'e1@1', text: 'a-value-that-should-not-be-repeated' } as never,
      { typed: 'Email', url: 'https://example.test/', title: 'T' } as never,
    ))
    assert.equal(text.includes('a-value-that-should-not-be-repeated'), false)
    assert.match(text, /Email/)
  })

  it('does not call a navigation that timed out a success', () => {
    const { tools } = mount()
    const text = textOf(tools.get('browser_navigate')?.output.render(
      { url: 'https://slow.test/' } as never,
      { url: 'https://slow.test/', title: 'Slow', tabRef: 't1', active: true, loaded: 'timeout' } as never,
    ))
    assert.match(text, /had not finished loading/)
    assert.match(text, /browser_wait/)
  })

  it('says when switch_tab could not bring the tab to the front', () => {
    const { tools } = mount()
    const render = tools.get('browser_switch_tab')?.output.render
    assert.ok(render)
    const base = { url: 'u', title: 't', tabRef: 't2', active: true, activeTabRef: 't2' }
    assert.match(textOf(render({ tabRef: 't2' } as never, { ...base, foregrounded: false } as never)), /did not bring it to the front/)
    assert.doesNotMatch(textOf(render({ tabRef: 't2' } as never, { ...base, foregrounded: true } as never)), /did not bring/)
  })
})
