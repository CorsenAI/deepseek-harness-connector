/**
 * The WebSocket transport for the broker (ADR 0001).
 *
 * This module owns sockets and nothing else: every routing and authorization decision lives in
 * `broker.ts`, behind the `PeerSocket` interface, so those rules are tested without a network.
 *
 * @module @corsen-ai/dsh-browser-connector/broker-server
 */

import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { Broker, type PeerSocket, type StateStore } from './broker.ts'
import { FrameError, parseFrame } from './frames.ts'
import { BROKER_HOST, DEFAULT_BROKER_PORT, ERROR, LIMITS } from './protocol.ts'

/** How the broker server binds and identifies itself. */
export interface BrokerServerOptions {
  /** The shared pairing secret. */
  readonly secret: string
  /** This broker's semantic version. */
  readonly version: string
  /** The loopback port to own. */
  readonly port?: number
  /** Durable ownership storage. */
  readonly store?: StateStore
  /** Where to write one line per notable event. */
  readonly log?: (line: string) => void
}

/**
 * Reject any bind address that could expose the broker beyond this computer.
 *
 * Checked rather than merely defaulted: a configuration mistake here would publish a service that
 * drives the user's signed-in browser to the local network.
 * @param host - the candidate host.
 * @returns the host, when it is a loopback address.
 * @throws when the host is anything else.
 */
export function requireLoopback(host: string): string {
  const value = String(host ?? '').trim()
  if (value === 'localhost') return value
  if (isIP(value) !== 0) {
    if (value === '::1' || value.startsWith('127.')) return value
  }
  throw new Error(`the connector broker host must be a loopback address, not ${JSON.stringify(host)}`)
}

/** A running broker process. */
export interface RunningBroker {
  /** The port actually bound. */
  readonly port: number
  /** The routing core, for tests and diagnostics. */
  readonly broker: Broker
  /** Stop listening and close every connection. */
  close(): Promise<void>
}

/**
 * One `ws` socket presented as the transport the router expects.
 *
 * A delivery failure is reported to the log and not propagated: a peer that cannot receive is
 * already disconnecting, and one dead socket must never fail another peer's request.
 */
class WebSocketPeer implements PeerSocket {
  readonly origin: string | undefined
  readonly #socket: WebSocket
  readonly #log: (line: string) => void

  /**
   * @param socket - the accepted connection.
   * @param origin - the request's Origin header, or `undefined` when it sent none.
   * @param log - where to report a failed delivery.
   */
  constructor(socket: WebSocket, origin: string | undefined, log: (line: string) => void) {
    this.#socket = socket
    this.origin = origin
    this.#log = log
  }

  /**
   * Deliver one frame, reporting rather than hiding a failure.
   *
   * A closed socket is the ordinary case and its `close` handler releases whatever the peer owned,
   * so delivery failure is not propagated to the router. It is logged, because a frame silently
   * vanishing here looks exactly like a broker that never routed the action.
   * @param frame - the frame to send.
   */
  send(frame: Record<string, unknown>): void {
    if (this.#socket.readyState !== this.#socket.OPEN) {
      this.#log(`dropped a ${String(frame['type'])} frame: the peer socket is no longer open`)
      return
    }
    this.#socket.send(JSON.stringify(frame), (cause) => {
      if (cause) this.#log(`failed to deliver a ${String(frame['type'])} frame: ${cause.message}`)
    })
  }

  close(code: number, reason: string): void {
    try {
      this.#socket.close(code, reason.slice(0, 120))
    } catch {
      // Already closing.
    }
  }
}

/**
 * Start the broker on loopback.
 *
 * An HTTP server is created explicitly so the upgrade path is the only route: a plain GET receives
 * a bare 426 rather than anything that could be probed for information.
 * @param options - secret, version, port, storage, and logging.
 * @returns the running broker.
 * @throws when the port is already held by another process.
 */
export async function startBroker(options: BrokerServerOptions): Promise<RunningBroker> {
  const host = requireLoopback(BROKER_HOST)
  const port = options.port ?? DEFAULT_BROKER_PORT
  const log = options.log ?? ((): void => {})
  const broker = new Broker({
    secret: options.secret,
    version: options.version,
    ...(options.store === undefined ? {} : { store: options.store }),
  })

  const http: Server = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('this endpoint accepts only WebSocket connections\n')
  })
  const sockets = new WebSocketServer({ server: http, maxPayload: LIMITS.MAX_FRAME_BYTES })
  // `ws` re-emits the HTTP server's errors on itself, and an emitter with no listener turns the
  // one error this function handles — the port already held — into an uncaught exception with a
  // stack trace in place of the sentence below. The HTTP server's own handler is the one that acts.
  sockets.on('error', () => {})

  sockets.on('connection', (socket, request) => {
    const origin = request.headers.origin
    const peer = new WebSocketPeer(socket, typeof origin === 'string' ? origin : undefined, log)
    broker.open(peer)

    socket.on('message', (data: Buffer) => {
      try {
        const { type, frame } = parseFrame(data)
        broker.handle(peer, type, frame)
      } catch (cause) {
        // A frame that cannot even be parsed is answered and the connection dropped: nothing this
        // peer sends afterwards can be interpreted, and keeping it open only invites a flood.
        const code = cause instanceof FrameError ? cause.code : ERROR.MALFORMED
        peer.send({ type: 'denied', code, message: cause instanceof Error ? cause.message : 'malformed frame' })
        peer.close(1008, code)
      }
    })
    socket.on('close', () => { broker.close(peer) })
    socket.on('error', () => { broker.close(peer) })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: NodeJS.ErrnoException): void => {
      reject(cause.code === 'EADDRINUSE'
        ? new Error(`the connector broker port ${port} is already in use; another broker may still be running`)
        : cause)
    }
    http.once('error', onError)
    http.listen(port, host, () => { http.removeListener('error', onError); resolve() })
  })

  // Port 0 asks the operating system for a free port, so the bound port is the only truthful one to
  // report. Tests rely on this; a caller that pinned a port gets the same number back.
  const address = http.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  log(`broker ${options.version} listening on ws://${host}:${boundPort}`)

  return {
    port: boundPort,
    broker,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    },
  }
}
