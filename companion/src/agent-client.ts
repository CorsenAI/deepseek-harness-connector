/**
 * The broker client used by every DeepSeek Harness plugin instance (ADR 0001).
 *
 * One client per DSH process. It authenticates as the `agent` role, announces the sessions live in
 * this process, and turns each tool call into one routed action request whose answer comes back on
 * the same connection.
 *
 * Ported from Corsen AI Hermes Connector v0.2.4 (`hermes-plugin/bridge_client.py`): the same
 * reconnect and request-correlation model, re-implemented in TypeScript.
 *
 * @module @corsen-ai/dsh-browser-connector/agent-client
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { brokerProof, createNonce, proofsMatch, roleProof } from './auth.ts'
import { parseFrame } from './frames.ts'
import {
  type ActionKind,
  CLIENT,
  ERROR,
  type ErrorCode,
  LIMITS,
  PROTOCOL_VERSION,
  ROLE,
  SERVER,
} from './protocol.ts'

/** A failure carrying the wire's typed code, so tools can explain the cause precisely. */
export class BrowserActionError extends Error {
  /** The typed reason. */
  readonly code: ErrorCode

  /**
   * @param code - the typed reason.
   * @param message - human-readable detail.
   */
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BrowserActionError'
    this.code = code
  }
}

/** The socket surface this client needs, so tests can supply a fake. */
export interface MinimalSocket {
  on(event: 'open' | 'close' | 'error', listener: () => void): void
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | string) => void): void
  send(data: string): void
  close(): void
}

/** Connection states this client reports. */
export type AgentClientStatus = 'connecting' | 'connected' | 'disconnected' | 'refused'

/** How this client connects and identifies itself. */
export interface AgentClientOptions {
  /** The broker address. */
  readonly url: string
  /** The shared pairing secret. */
  readonly secret: string
  /** This connector's semantic version. */
  readonly version: string
  /** The routing profile this plugin instance belongs to. */
  readonly profileId: string
  /** A display name for the panel. */
  readonly name: string
  /** Called when the connection state changes, for logging. */
  readonly onStatus?: (status: AgentClientStatus, detail: string) => void
  /** Injected socket factory, for tests. */
  readonly createSocket?: (url: string) => MinimalSocket
}

/** Backoff bounds for reconnecting. A bounded schedule avoids a tight loop against a dead port. */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 15_000

/** Connects one DeepSeek Harness process to the local broker. */
export class AgentClient {
  readonly #options: AgentClientOptions
  readonly #agentId = `agent-${randomUUID()}`
  readonly #sessions = new Map<string, string>()
  readonly #inflight = new Map<string, {
    resolve: (value: unknown) => void
    reject: (cause: BrowserActionError) => void
  }>()

  #socket: MinimalSocket | null = null
  #authenticated = false
  #closed = false
  #attempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #clientNonce = ''
  #requestCounter = 0

  /**
   * @param options - connection, identity, and reporting.
   */
  constructor(options: AgentClientOptions) {
    this.#options = options
  }

  /** Whether the broker has accepted this client. */
  get connected(): boolean {
    return this.#authenticated
  }

  /** Open the connection and keep it open until {@link dispose}. */
  start(): void {
    if (this.#closed) return
    this.#connect()
  }

  /** Close the connection and fail every request still waiting. */
  dispose(): void {
    this.#closed = true
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#failAll(
      ERROR.INTERRUPTED,
      'the connector plugin was unloaded while this action was in flight; the browser may have performed it',
    )
    this.#socket?.close()
    this.#socket = null
    this.#authenticated = false
  }

  /**
   * Record one live session and tell the broker.
   * @param sessionId - the DeepSeek Harness session id.
   * @param title - a short label for the panel.
   */
  addSession(sessionId: string, title: string): void {
    if (this.#sessions.size >= LIMITS.MAX_SESSIONS_PER_AGENT && !this.#sessions.has(sessionId)) return
    this.#sessions.set(sessionId, title)
    this.#announce()
  }

  /**
   * Forget one session that ended.
   * @param sessionId - the DeepSeek Harness session id.
   */
  removeSession(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) return
    if (this.#authenticated) this.#send({ type: CLIENT.SESSION_RETIRE, sessionId })
  }

  /**
   * Perform one browser action for one exact session.
   * @param sessionId - the calling session.
   * @param kind - the action kind.
   * @param args - the action arguments.
   * @param signal - the tool call's cancellation signal.
   * @returns the browser's canonical result payload.
   * @throws {BrowserActionError} when the action was refused, failed, or could not be routed.
   */
  async request(
    sessionId: string,
    kind: ActionKind,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#authenticated) {
      throw new BrowserActionError(
        ERROR.NO_BROWSER,
        'the DeepSeek Harness Connector broker is not reachable; check that the connector is installed and Chrome is paired',
      )
    }
    if (signal?.aborted === true) throw new BrowserActionError(ERROR.TIMEOUT, 'the call was cancelled before it started')

    const id = `q${this.#requestCounter++}`
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.#inflight.delete(id)
        reject(new BrowserActionError(ERROR.TIMEOUT, 'the call was cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#inflight.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (cause) => { signal?.removeEventListener('abort', onAbort); reject(cause) },
      })
      this.#send({
        type: CLIENT.ACTION_REQUEST,
        id,
        profileId: this.#options.profileId,
        sessionId,
        action: { kind, args },
      })
    })
  }

  // -- connection -----------------------------------------------------------

  /** Open one socket and wire its lifecycle. */
  #connect(): void {
    if (this.#closed) return
    this.#report('connecting', this.#options.url)
    const factory = this.#options.createSocket
      ?? ((url: string) => new WebSocket(url) as unknown as MinimalSocket)
    const socket = factory(this.#options.url)
    this.#socket = socket
    this.#authenticated = false

    socket.on('open', () => { this.#clientNonce = createNonce() })
    socket.on('message', (data) => { this.#onMessage(socket, data) })
    socket.on('error', () => { /* `close` always follows, and reconnection is handled there. */ })
    socket.on('close', () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#authenticated = false
      // Every request still waiting here had already been sent, so its action may have run in the
      // browser before the connection dropped. Nothing is ever re-sent on reconnect: a replay could
      // submit a form or close a tab a second time.
      this.#failAll(
        ERROR.INTERRUPTED,
        'the connection to the connector broker closed while this action was in flight; the browser may have performed it',
      )
      this.#report('disconnected', 'the broker connection closed')
      this.#scheduleReconnect()
    })
  }

  /** Reconnect after a bounded, growing delay. */
  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.#attempts, 5))
    this.#attempts += 1
    const timer = setTimeout(() => { this.#reconnectTimer = null; this.#connect() }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this.#reconnectTimer = timer
  }

  /**
   * Handle one frame from the broker.
   * @param socket - the socket it arrived on.
   * @param data - the raw payload.
   */
  #onMessage(socket: MinimalSocket, data: Buffer | ArrayBuffer | string): void {
    if (this.#socket !== socket) return
    let parsed: { type: string, frame: Record<string, unknown> }
    try {
      parsed = parseFrame(data)
    } catch {
      // The broker is the only writer on this socket, so an unparseable frame means the peer is not
      // the broker. Closing forces a fresh authenticated handshake.
      socket.close()
      return
    }
    const { type, frame } = parsed
    switch (type) {
      case SERVER.CHALLENGE: return this.#onChallenge(frame)
      case SERVER.PAIRED: return this.#onPaired(frame)
      case SERVER.DENIED: return this.#onDenied(frame)
      case SERVER.ACTION_RESPONSE: return this.#onResponse(frame)
      case SERVER.PING: return this.#send({ type: CLIENT.PONG, id: frame['id'] })
      default: return
    }
  }

  /**
   * Answer the broker's challenge with a role-bound proof.
   * @param frame - the challenge frame.
   */
  #onChallenge(frame: Record<string, unknown>): void {
    const nonce = frame['nonce']
    if (typeof nonce !== 'string') return
    if (this.#clientNonce === '') this.#clientNonce = createNonce()
    this.#send({
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: this.#agentId,
      profileId: this.#options.profileId,
      name: this.#options.name,
      nonce: this.#clientNonce,
      proof: roleProof(this.#options.secret, ROLE.AGENT, this.#agentId, nonce),
      protocolVersion: PROTOCOL_VERSION,
      connectorVersion: this.#options.version,
    })
  }

  /**
   * Verify the broker's answering proof before trusting the connection.
   *
   * Without this check, a process that squatted on the port after the real broker exited would
   * receive every routed action and every page result (ADR 0003).
   * @param frame - the paired frame.
   */
  #onPaired(frame: Record<string, unknown>): void {
    const supplied = frame['proof']
    const expected = brokerProof(this.#options.secret, ROLE.AGENT, this.#agentId, this.#clientNonce)
    if (typeof supplied !== 'string' || !proofsMatch(supplied, expected)) {
      this.#report('refused', 'the broker did not prove the shared pairing secret')
      this.#socket?.close()
      return
    }
    this.#authenticated = true
    this.#attempts = 0
    this.#report('connected', String(frame['brokerVersion'] ?? 'unknown'))
    this.#announce()
  }

  /**
   * Report a refusal, and stop retrying when retrying cannot help.
   * @param frame - the denied frame.
   */
  #onDenied(frame: Record<string, unknown>): void {
    const code = String(frame['code'] ?? ERROR.INTERNAL)
    const message = String(frame['message'] ?? 'the broker refused the connection')
    this.#report('refused', `${code}: ${message}`)
    // A version mismatch cannot be fixed by reconnecting. Staying quiet until the user updates one
    // side is better than reconnecting forever against an incompatible broker.
    if (code === ERROR.PROTOCOL_VERSION) this.#closed = true
    this.#failAll(code as ErrorCode, message)
  }

  /**
   * Settle one in-flight request.
   * @param frame - the response frame.
   */
  #onResponse(frame: Record<string, unknown>): void {
    const id = String(frame['id'] ?? '')
    const waiting = this.#inflight.get(id)
    if (!waiting) return
    this.#inflight.delete(id)
    if (frame['ok'] === true) { waiting.resolve(frame['data'] ?? null); return }
    const raw = frame['error']
    const error = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    waiting.reject(new BrowserActionError(
      (typeof error['code'] === 'string' ? error['code'] : ERROR.ACTION_FAILED) as ErrorCode,
      String(error['message'] ?? 'the browser action failed'),
    ))
  }

  /** Tell the broker which sessions are live here. */
  #announce(): void {
    if (!this.#authenticated) return
    this.#send({
      type: CLIENT.SESSION_ANNOUNCE,
      sessions: [...this.#sessions].map(([sessionId, title]) => ({ sessionId, title })),
    })
  }

  /**
   * Fail every waiting request with one cause.
   * @param code - the typed reason.
   * @param message - human-readable detail.
   */
  #failAll(code: ErrorCode, message: string): void {
    for (const [id, waiting] of [...this.#inflight]) {
      this.#inflight.delete(id)
      waiting.reject(new BrowserActionError(code, message))
    }
  }

  /**
   * Send one frame, ignoring a closed socket.
   * @param frame - the frame to send.
   */
  #send(frame: Record<string, unknown>): void {
    try {
      this.#socket?.send(JSON.stringify(frame))
    } catch {
      // The socket closed between the check and the write; the `close` listener owns reconnection.
    }
  }

  /**
   * Report a connection state change.
   * @param status - the new state.
   * @param detail - context for the log line.
   */
  #report(status: AgentClientStatus, detail: string): void {
    this.#options.onStatus?.(status, detail)
  }
}
