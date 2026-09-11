/**
 * A recording relay between one client and the broker.
 *
 * Some claims are about what crosses the trust boundary, not about what a module returns: whether
 * the pairing secret ever appears on the wire, whether a page's text became a frame. The only
 * honest way to check those is to read the bytes each side actually sent. The relay sits on its
 * own loopback port, forwards every frame unchanged in both directions, and keeps a copy. Nothing
 * in the product knows it exists; the extension and the agent are simply told to connect here.
 *
 * The `Origin` header is forwarded exactly as received, because the broker's admission rule reads
 * it: a browser must arrive from an extension origin, an agent from none. A relay that added or
 * dropped it would be testing itself.
 * @module
 */

import { WebSocket, WebSocketServer, type RawData } from 'ws'

/** One frame the relay saw. */
export interface TappedFrame {
  /** Which side sent it. */
  readonly direction: 'to-broker' | 'from-broker'
  /** The exact payload, as text. */
  readonly bytes: string
  /** Wall-clock order across every connection the relay carried. */
  readonly sequence: number
}

/** A running relay. */
export interface Wiretap {
  /** The loopback port clients connect to. */
  readonly port: number
  /** The address in the form the extension's settings and the agent client take. */
  readonly url: string
  /** Every frame seen so far, in the order it was seen. */
  readonly frames: readonly TappedFrame[]
  /** Frames seen after a given sequence number. */
  since(sequence: number): readonly TappedFrame[]
  /** The sequence number the next frame will get, for marking a point in time. */
  mark(): number
  /** Close every relayed connection and stop listening. */
  close(): Promise<void>
}

/**
 * Start a relay in front of the broker.
 * @param brokerPort - the broker's loopback port.
 * @returns the running relay.
 */
export async function startWiretap(brokerPort: number): Promise<Wiretap> {
  const frames: TappedFrame[] = []
  let sequence = 0
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const upstreams = new Set<WebSocket>()

  server.on('connection', (downstream, request) => {
    const origin = request.headers.origin
    const upstream = new WebSocket(`ws://127.0.0.1:${brokerPort}`, typeof origin === 'string' ? { origin } : {})
    upstreams.add(upstream)
    // A frame is forwarded with the opcode it arrived with. `ws` hands every payload over as a
    // Buffer and would send a Buffer back as a binary frame; the extension reads text frames only.
    const queued: { data: RawData, binary: boolean }[] = []

    const record = (direction: TappedFrame['direction'], data: RawData): void => {
      frames.push({ direction, bytes: data.toString(), sequence: sequence++ })
    }

    downstream.on('message', (data, binary) => {
      record('to-broker', data)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else queued.push({ data, binary })
    })
    upstream.on('open', () => {
      for (const { data, binary } of queued) upstream.send(data, { binary })
      queued.length = 0
    })
    upstream.on('message', (data, binary) => {
      record('from-broker', data)
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary })
    })

    const closeBoth = (code: number, reason: Buffer | string): void => {
      const text = reason.toString().slice(0, 120)
      // Only the standard closure codes may be sent by an endpoint; anything else becomes 1000.
      const sendable = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000
      try { downstream.close(sendable, text) } catch { /* already closed */ }
      try { upstream.close(sendable, text) } catch { /* already closed */ }
      upstreams.delete(upstream)
    }
    downstream.on('close', closeBoth)
    upstream.on('close', closeBoth)
    downstream.on('error', () => { closeBoth(1011, 'relay error') })
    upstream.on('error', () => { closeBoth(1011, 'relay error') })
  })

  await new Promise<void>((resolve) => { server.once('listening', () => { resolve() }) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    frames,
    since: (from) => frames.filter((frame) => frame.sequence >= from),
    mark: () => sequence,
    close: async () => {
      for (const socket of server.clients) socket.terminate()
      for (const socket of upstreams) socket.terminate()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
