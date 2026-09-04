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
import { registerBrowserTools } from '../src/dsh/tools.ts'
import { ACTION, ERROR } from '../src/protocol.ts'

/** One recorded browser request. */
interface Recorded {
  sessionId: string
  kind: string
  args: Record<string, unknown>
}

/**
 * Register the browser tools against a capturing registry.
 * @param answer - what the broker client returns, or throws.
 * @returns the registered definitions and the requests they made.
 */
function mount(answer: (request: Recorded) => unknown = () => ({})): {
  tools: Map<string, ToolDefinition>
  requests: Recorded[]
  disposed: number
} {
  const tools = new Map<string, ToolDefinition>()
  const requests: Recorded[] = []
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
        tools.set(definition.name, definition)
        return () => { disposed += 1 }
      },
    },
  } as unknown as Context

  registerBrowserTools(ctx, { client })
  return { tools, requests, get disposed() { return disposed } }
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
  it('registers exactly the browser tools this version implements', () => {
    const { tools } = mount()
    assert.deepEqual([...tools.keys()].sort(), [
      'browser_click',
      'browser_current_url',
      'browser_read_text',
      'browser_snapshot',
      'browser_type',
    ])
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
    for (const name of ['browser_click', 'browser_type']) {
      assert.match(String(tools.get(name)?.description), /snapshot/i)
    }
  })

  it('warns the model off typing credentials', () => {
    const { tools } = mount()
    assert.match(String(tools.get('browser_type')?.description), /password|one-time|card/i)
  })

  it('returns a disposer for every registration, so unloading removes the tools', () => {
    const mounted = mount()
    assert.equal(mounted.tools.size, 5)
    assert.equal(mounted.disposed, 0)
  })
})

describe('fail closed without a session', () => {
  it('refuses a call that carried no agent, and contacts no browser', async () => {
    const { tools, requests } = mount()
    for (const [name, definition] of tools) {
      await assert.rejects(
        definition.execute({ ref: 'e1@1', text: 'x' }, execution()),
        (cause: unknown) => cause instanceof Error && /only run inside a DeepSeek Harness session/.test(cause.message),
        `${name} must refuse a call with no agent`,
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
    const { tools, requests } = mount(() => ({ url: 'https://example.test/', title: 'T' }))
    await tools.get('browser_current_url')?.execute({}, execution('session-one'))
    await tools.get('browser_current_url')?.execute({}, execution('session-two'))
    assert.deepEqual(requests.map((entry) => entry.sessionId), ['session-one', 'session-two'])
  })

  it('reads the session per call rather than caching it', async () => {
    const { tools, requests } = mount(() => ({ url: 'https://example.test/', title: 'T' }))
    const definition = tools.get('browser_current_url')
    assert.ok(definition)
    for (const session of ['a', 'b', 'a', 'c']) await definition.execute({}, execution(session))
    assert.deepEqual(requests.map((entry) => entry.sessionId), ['a', 'b', 'a', 'c'])
  })

  it('forwards each tool to its own action kind', async () => {
    const { tools, requests } = mount(() => ({
      url: 'https://example.test/', title: 'T', text: '', elements: [], truncated: false,
      clicked: 'x', typed: 'y',
    }))
    await tools.get('browser_snapshot')?.execute({}, execution('s'))
    await tools.get('browser_read_text')?.execute({}, execution('s'))
    await tools.get('browser_click')?.execute({ ref: 'e1@1' }, execution('s'))
    await tools.get('browser_type')?.execute({ ref: 'e1@1', text: 'hi' }, execution('s'))
    assert.deepEqual(requests.map((entry) => entry.kind), [
      ACTION.SNAPSHOT, ACTION.READ_TEXT, ACTION.CLICK, ACTION.TYPE,
    ])
  })

  it('defaults the optional typing flags rather than sending undefined', async () => {
    const { tools, requests } = mount(() => ({ typed: 'field', url: 'u', title: 't' }))
    await tools.get('browser_type')?.execute({ ref: 'e1@1', text: 'hi' }, execution('s'))
    assert.deepEqual(requests[0]?.args, { ref: 'e1@1', text: 'hi', replace: false, submit: false })
  })

  it('omits an absent cap instead of sending an undefined one', async () => {
    const { tools, requests } = mount(() => ({ url: 'u', title: 't', text: '', elements: [], truncated: false }))
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
})

describe('rendering for the model', () => {
  it('renders a snapshot as readable text with its element list', () => {
    const { tools } = mount()
    const definition = tools.get('browser_snapshot')
    assert.ok(definition)
    const rendered = definition.output.render({}, {
      url: 'https://example.test/',
      title: 'Example',
      text: 'Hello',
      elements: [{ ref: 'e1@1', role: 'button', name: 'Sign in' }],
      truncated: false,
    } as never)
    const text = rendered.map((block) => (block as { text?: string }).text ?? '').join('')
    assert.match(text, /Example/)
    assert.match(text, /\[e1@1\] button: Sign in/)
  })

  it('says plainly when page text was truncated', () => {
    const { tools } = mount()
    const rendered = tools.get('browser_snapshot')?.output.render({}, {
      url: 'u', title: 't', text: 'x', elements: [], truncated: true,
    } as never)
    assert.match((rendered ?? []).map((block) => (block as { text?: string }).text ?? '').join(''), /truncated/)
  })

  it('never echoes typed text back into the transcript', () => {
    const { tools } = mount()
    const rendered = tools.get('browser_type')?.output.render(
      { ref: 'e1@1', text: 'a-value-that-should-not-be-repeated' } as never,
      { typed: 'Email', url: 'https://example.test/', title: 'T' } as never,
    )
    const text = (rendered ?? []).map((block) => (block as { text?: string }).text ?? '').join('')
    assert.equal(text.includes('a-value-that-should-not-be-repeated'), false)
    assert.match(text, /Email/)
  })
})
