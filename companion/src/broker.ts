/**
 * The routing core (ADR 0001, ADR 0007).
 *
 * The broker owns which browser holds each scope, forwards one agent's action to that browser's
 * bound tab, and revalidates ownership again when the result comes back. It never executes a
 * browser action itself and never chooses a target when the calling scope has no binding.
 *
 * Transport is abstracted behind {@link PeerSocket} so every routing and authorization rule below is
 * testable without a network. `broker-server.ts` supplies the real WebSocket implementation.
 *
 * Ported from Corsen AI Hermes Connector v0.2.4 (`hermes-plugin/broker.py`): the same routing model,
 * ownership transfer semantics, and post-action revalidation, re-implemented in TypeScript over the
 * DeepSeek Harness scope identity.
 *
 * @module @corsen-ai/dsh-browser-connector/broker
 */

import { brokerProof, createNonce, proofsMatch, roleProof } from './auth.ts'
import {
  type Registry,
  applyBinding,
  bindingList,
  EMPTY,
  lookup,
  normalizeBinding,
  removeScope,
} from './bindings.ts'
import {
  acceptedCapabilities,
  displayText,
  FrameError,
  requireAction,
  requireId,
  requireRole,
  requireScope,
} from './frames.ts'
import {
  type ActionKind,
  type Binding,
  BINDING_MUTATING_ACTIONS,
  CLIENT,
  ERROR,
  type ErrorCode,
  LIMITS,
  PROTOCOL_VERSION,
  ROLE,
  type Role,
  type Scope,
  scopeKey,
  SERVER,
} from './protocol.ts'

/** The transport this broker speaks over, reduced to what routing needs. */
export interface PeerSocket {
  /** The connection's `Origin` header, or `undefined` when the client sent none. */
  readonly origin: string | undefined
  /**
   * Deliver one frame. Failures are swallowed by the caller: a peer that cannot receive is already
   * disconnecting, and one dead socket must not fail another peer's request.
   * @param frame - the frame to serialise and send.
   */
  send(frame: Record<string, unknown>): void
  /**
   * Close the connection.
   * @param code - the WebSocket close code.
   * @param reason - a short human-readable reason.
   */
  close(code: number, reason: string): void
}

/** What the broker persists between runs: which browser the user last attached each scope in. */
export interface BrokerState {
  /** Scope key to browser id. */
  readonly scopeOwners: Readonly<Record<string, string>>
}

/** Durable storage for {@link BrokerState}. */
export interface StateStore {
  /**
   * @returns the last saved state, or an empty state on first run or after an unreadable file.
   */
  load(): BrokerState
  /**
   * @param state - the state to persist.
   */
  save(state: BrokerState): void
}

/** A store that keeps state only for this process. Used by tests and by `--ephemeral`. */
export const MEMORY_STORE: StateStore = (() => {
  let held: BrokerState = { scopeOwners: {} }
  return { load: () => held, save: (state) => { held = state } }
})()

/** One authenticated Chrome extension installation. */
interface BrowserPeer {
  readonly kind: 'browser'
  readonly socket: PeerSocket
  readonly browserId: string
  readonly name: string
  readonly capabilities: ReadonlySet<ActionKind>
  bindings: Registry
}

/** One authenticated DeepSeek Harness plugin instance. */
interface AgentPeer {
  readonly kind: 'agent'
  readonly socket: PeerSocket
  readonly agentId: string
  readonly profileId: string
  readonly name: string
  /** Sessions this plugin instance currently has live, by session id. */
  sessions: Map<string, string>
  /** Requests this agent is waiting on, by its own request id. */
  pendingIds: Set<string>
}

/** A connection that has sent a challenge but has not yet authenticated. */
interface PendingPeer {
  readonly socket: PeerSocket
  readonly serverNonce: string
}

/** One dispatched action, held until the browser answers or the deadline passes. */
interface PendingAction {
  readonly agent: AgentPeer
  readonly agentRequestId: string
  readonly browser: BrowserPeer
  readonly scopeKey: string
  readonly targetTabId: number
  readonly kind: ActionKind
  readonly timer: ReturnType<typeof setTimeout>
}

/** Options for one broker instance. */
export interface BrokerOptions {
  /** The shared pairing secret both roles prove knowledge of. */
  readonly secret: string
  /** This broker's semantic version, reported in the handshake. */
  readonly version: string
  /** Durable ownership storage. */
  readonly store?: StateStore
  /** Deadline for one dispatched action. */
  readonly actionTimeoutMs?: number
}

/** A session as the panel sees it: which profile it belongs to and whether it is reachable. */
export interface SessionView {
  readonly profileId: string
  readonly sessionId: string
  readonly title: string
  /** The browser holding this scope's tabs, when one does. */
  readonly browserId?: string
  readonly tabIds: readonly number[]
  readonly activeTabId?: number
}

/**
 * Routes browser actions from DeepSeek Harness sessions to explicitly attached Chrome tabs.
 *
 * One instance per broker process. Every method is synchronous: the broker holds no locks because a
 * single-threaded event loop makes each frame's handling atomic with respect to every other frame.
 */
export class Broker {
  readonly #secret: string
  readonly #version: string
  readonly #store: StateStore
  readonly #actionTimeoutMs: number

  readonly #pendingPeers = new Map<PeerSocket, PendingPeer>()
  readonly #browsers = new Map<string, BrowserPeer>()
  readonly #agents = new Map<string, AgentPeer>()
  readonly #peersBySocket = new Map<PeerSocket, BrowserPeer | AgentPeer>()
  readonly #pending = new Map<string, PendingAction>()

  /** Scope key to the browser id that owns it. Survives restarts through {@link StateStore}. */
  #scopeOwners: Map<string, string>

  #nextRequestId = 1

  /**
   * @param options - the pairing secret, this broker's version, and optional storage and deadline.
   */
  constructor(options: BrokerOptions) {
    this.#secret = options.secret
    this.#version = options.version
    this.#store = options.store ?? MEMORY_STORE
    this.#actionTimeoutMs = options.actionTimeoutMs ?? LIMITS.ACTION_TIMEOUT_MS
    this.#scopeOwners = new Map(Object.entries(this.#store.load().scopeOwners))
  }

  /**
   * Begin one connection's handshake.
   *
   * The challenge carries the broker's protocol and product versions so a mismatched peer can show
   * an accurate message before it proves anything (ADR 0004).
   * @param socket - the newly connected transport.
   */
  open(socket: PeerSocket): void {
    const serverNonce = createNonce()
    this.#pendingPeers.set(socket, { socket, serverNonce })
    socket.send({
      type: SERVER.CHALLENGE,
      nonce: serverNonce,
      protocolVersion: PROTOCOL_VERSION,
      brokerVersion: this.#version,
    })
  }

  /**
   * Handle one already-parsed frame.
   *
   * A {@link FrameError} thrown by validation is answered as a `denied` frame and closes the
   * connection when the peer is not yet authenticated, or as a typed failure when it is; either way
   * one hostile frame never affects another peer.
   * @param socket - the connection the frame arrived on.
   * @param type - the frame's `type`.
   * @param frame - the validated-as-an-object frame body.
   */
  handle(socket: PeerSocket, type: string, frame: Record<string, unknown>): void {
    try {
      const peer = this.#peersBySocket.get(socket)
      if (!peer) {
        if (type !== CLIENT.HELLO) throw new FrameError(ERROR.UNAUTHENTICATED, 'authenticate first')
        this.#authenticate(socket, frame)
        return
      }
      if (peer.kind === 'browser') this.#handleBrowser(peer, type, frame)
      else this.#handleAgent(peer, type, frame)
    } catch (cause) {
      this.#reject(socket, cause)
    }
  }

  /**
   * Release everything one connection owned.
   *
   * A browser's bindings are dropped from the live view but its *ownership* preference is kept, so
   * a Chrome restart restores the same scope-to-browser mapping instead of orphaning it.
   * @param socket - the closed connection.
   */
  close(socket: PeerSocket): void {
    this.#pendingPeers.delete(socket)
    const peer = this.#peersBySocket.get(socket)
    if (!peer) return
    this.#peersBySocket.delete(socket)

    if (peer.kind === 'browser') {
      if (this.#browsers.get(peer.browserId) === peer) this.#browsers.delete(peer.browserId)
      for (const [id, action] of [...this.#pending]) {
        // The action reached the browser and may have run there before the connection died; the
        // caller must be told the outcome is unknown, not that nothing happened.
        if (action.browser === peer) {
          this.#settle(id, {
            code: ERROR.INTERRUPTED,
            message: 'the browser disconnected while the action was running; it may have performed it',
          })
        }
      }
    } else {
      if (this.#agents.get(peer.agentId) === peer) this.#agents.delete(peer.agentId)
      for (const [id, action] of [...this.#pending]) {
        // The requester is gone; drop the record so a late browser result cannot be delivered to a
        // reconnected agent that never asked for it.
        if (action.agent === peer) { clearTimeout(action.timer); this.#pending.delete(id) }
      }
    }
    this.#broadcastState()
  }

  /** @returns every session the panel should show, with the tabs each currently owns. */
  sessions(): SessionView[] {
    const views: SessionView[] = []
    for (const agent of this.#agents.values()) {
      for (const [sessionId, title] of agent.sessions) {
        const scope: Scope = { profileId: agent.profileId, sessionId }
        const key = scopeKey(scope.profileId, scope.sessionId)
        const browserId = this.#scopeOwners.get(key)
        const binding = browserId ? lookup(this.#browsers.get(browserId)?.bindings ?? EMPTY, scope) : undefined
        views.push({
          profileId: agent.profileId,
          sessionId,
          title,
          ...(browserId === undefined ? {} : { browserId }),
          tabIds: binding?.tabIds ?? [],
          ...(binding === undefined ? {} : { activeTabId: binding.activeTabId }),
        })
      }
    }
    return views.sort((left, right) => (
      left.profileId.localeCompare(right.profileId) || left.sessionId.localeCompare(right.sessionId)
    ))
  }

  // -- authentication -------------------------------------------------------

  /**
   * Verify one `hello` frame and admit the client in its claimed role.
   * @param socket - the connection.
   * @param frame - the hello frame.
   */
  #authenticate(socket: PeerSocket, frame: Record<string, unknown>): void {
    const waiting = this.#pendingPeers.get(socket)
    if (!waiting) throw new FrameError(ERROR.UNAUTHENTICATED, 'no challenge is outstanding')

    const claimed = frame['protocolVersion']
    if (claimed !== PROTOCOL_VERSION) {
      const older = typeof claimed === 'number' && claimed < PROTOCOL_VERSION ? 'client' : 'broker'
      throw new FrameError(
        ERROR.PROTOCOL_VERSION,
        `protocol ${String(claimed)} cannot talk to protocol ${PROTOCOL_VERSION}; the ${older} is older`,
      )
    }

    const role: Role = requireRole(frame['role'])
    const clientId = requireId(frame['id'], 'id')
    const origin = socket.origin

    // Origin is a precondition on the class of caller, never the identity (ADR 0003).
    if (role === ROLE.BROWSER && !(origin ?? '').startsWith('chrome-extension://')) {
      throw new FrameError(ERROR.UNAUTHENTICATED, 'a browser client must connect from an extension origin')
    }
    if (role === ROLE.AGENT && origin !== undefined && origin !== '') {
      throw new FrameError(ERROR.UNAUTHENTICATED, 'an agent client must not present an origin')
    }

    const supplied = frame['proof']
    if (typeof supplied !== 'string' || !proofsMatch(supplied, roleProof(this.#secret, role, clientId, waiting.serverNonce))) {
      throw new FrameError(ERROR.UNAUTHENTICATED, 'pairing proof did not verify')
    }

    const clientNonce = requireId(frame['nonce'], 'nonce')
    this.#pendingPeers.delete(socket)

    if (role === ROLE.BROWSER) this.#admitBrowser(socket, clientId, frame)
    else this.#admitAgent(socket, clientId, frame)

    socket.send({
      type: SERVER.PAIRED,
      proof: brokerProof(this.#secret, role, clientId, clientNonce),
      protocolVersion: PROTOCOL_VERSION,
      brokerVersion: this.#version,
    })
    this.#broadcastState()
  }

  /**
   * Admit a browser, displacing any earlier connection with the same identity.
   * @param socket - the connection.
   * @param browserId - the extension installation's persistent id.
   * @param frame - the hello frame.
   */
  #admitBrowser(socket: PeerSocket, browserId: string, frame: Record<string, unknown>): void {
    const previous = this.#browsers.get(browserId)
    const peer: BrowserPeer = {
      kind: 'browser',
      socket,
      browserId,
      name: displayText(frame['name'], 'Chrome'),
      capabilities: new Set(acceptedCapabilities(frame['capabilities'])),
      // A reconnecting browser starts with no live bindings and restores them with `binding_sync`.
      bindings: previous?.bindings ?? EMPTY,
    }
    this.#browsers.set(browserId, peer)
    this.#peersBySocket.set(socket, peer)
    if (previous && previous.socket !== socket) {
      this.#peersBySocket.delete(previous.socket)
      previous.socket.close(1000, 'replaced by a newer connection from the same browser')
    }
  }

  /**
   * Admit a DeepSeek Harness plugin instance.
   * @param socket - the connection.
   * @param agentId - this plugin instance's id, unique per process.
   * @param frame - the hello frame.
   */
  #admitAgent(socket: PeerSocket, agentId: string, frame: Record<string, unknown>): void {
    const peer: AgentPeer = {
      kind: 'agent',
      socket,
      agentId,
      profileId: requireId(frame['profileId'], 'profileId'),
      name: displayText(frame['name'], 'DeepSeek Harness'),
      sessions: new Map(),
      pendingIds: new Set(),
    }
    const previous = this.#agents.get(agentId)
    this.#agents.set(agentId, peer)
    this.#peersBySocket.set(socket, peer)
    if (previous && previous.socket !== socket) {
      this.#peersBySocket.delete(previous.socket)
      previous.socket.close(1000, 'replaced by a newer connection from the same agent')
    }
  }

  // -- browser frames -------------------------------------------------------

  /**
   * Dispatch one frame from an authenticated browser.
   * @param peer - the browser.
   * @param type - the frame type.
   * @param frame - the frame body.
   */
  #handleBrowser(peer: BrowserPeer, type: string, frame: Record<string, unknown>): void {
    if (this.#browsers.get(peer.browserId) !== peer) return

    switch (type) {
      case CLIENT.BINDING_SYNC: return this.#onBindingSync(peer, frame)
      case CLIENT.BINDING_UPDATE: return this.#onBindingUpdate(peer, frame)
      case CLIENT.BINDING_REMOVE: return this.#onBindingRemove(peer, frame)
      case CLIENT.ACTION_RESULT: return this.#onActionResult(peer, frame)
      case CLIENT.PONG: return
      default: throw new FrameError(ERROR.MALFORMED, `a browser may not send ${JSON.stringify(type)}`)
    }
  }

  /**
   * Restore one browser's bindings after a reconnect.
   *
   * A sync is restoration, never a claim: a scope another browser owns is refused and revoked
   * locally, so a stale profile coming back online cannot silently steal a session (ADR 0007).
   * @param peer - the browser.
   * @param frame - the sync frame.
   */
  #onBindingSync(peer: BrowserPeer, frame: Record<string, unknown>): void {
    const raw = frame['bindings']
    if (!Array.isArray(raw)) throw new FrameError(ERROR.MALFORMED, 'bindings must be an array')
    if (raw.length > LIMITS.MAX_BINDINGS_PER_BROWSER) {
      throw new FrameError(ERROR.TOO_LARGE, 'too many bindings in one sync')
    }

    const accepted: Record<string, Binding> = {}
    const revoked: Binding[] = []
    const seen = new Set<string>()
    const claimedTabs = new Set<number>()
    for (const entry of raw) {
      let binding: Binding | null
      try {
        binding = normalizeBinding(entry)
      } catch (cause) {
        throw new FrameError(ERROR.MALFORMED, (cause as Error).message)
      }
      if (!binding) continue
      const key = scopeKey(binding.profileId, binding.sessionId)
      if (seen.has(key)) throw new FrameError(ERROR.MALFORMED, 'a sync named the same scope twice')
      // One tab has one owner. A sync claiming a tab under two sessions is refused whole rather
      // than silently resolved, because either resolution would be a guess about which session the
      // user meant, and guessing is what fail-closed routing exists to prevent.
      for (const tabId of binding.tabIds) {
        if (claimedTabs.has(tabId)) {
          throw new FrameError(ERROR.MALFORMED, `tab ${tabId} was claimed by two sessions in one sync`)
        }
        claimedTabs.add(tabId)
      }
      seen.add(key)
      const owner = this.#scopeOwners.get(key)
      if (owner !== undefined && owner !== peer.browserId) { revoked.push(binding); continue }
      accepted[key] = binding
      this.#scopeOwners.set(key, peer.browserId)
    }

    // A scope this browser owns but did not send is an explicit local detachment.
    for (const [key, owner] of [...this.#scopeOwners]) {
      if (owner === peer.browserId && !seen.has(key)) this.#scopeOwners.delete(key)
    }

    peer.bindings = Object.freeze(accepted)
    this.#persist()
    for (const binding of revoked) this.#revoke(peer, binding, 'this session is attached in another Chrome profile')
    this.#broadcastState()
  }

  /**
   * Apply one explicit user attachment, transferring the scope to this browser.
   * @param peer - the browser the user acted in.
   * @param frame - the update frame.
   */
  #onBindingUpdate(peer: BrowserPeer, frame: Record<string, unknown>): void {
    let binding: Binding | null
    try {
      binding = normalizeBinding(frame)
    } catch (cause) {
      throw new FrameError(ERROR.MALFORMED, (cause as Error).message)
    }
    if (!binding) throw new FrameError(ERROR.MALFORMED, 'an attachment must name at least one tab')
    if (Object.keys(peer.bindings).length >= LIMITS.MAX_BINDINGS_PER_BROWSER
      && !(scopeKey(binding.profileId, binding.sessionId) in peer.bindings)) {
      throw new FrameError(ERROR.TOO_LARGE, 'too many bindings for one browser')
    }

    const key = scopeKey(binding.profileId, binding.sessionId)
    // The previous owner loses authority before this one gains it, so no interval exists in which
    // two browsers both believe they hold the scope.
    for (const other of this.#browsers.values()) {
      if (other === peer || !(key in other.bindings)) continue
      other.bindings = removeScope(other.bindings, binding)
      this.#revoke(other, binding, 'this session was attached in another Chrome profile')
    }
    // `applyBinding` also strips these tabs from every other scope in this same browser, so a
    // browser reporting one tab under two sessions cannot make the broker route both to it.
    peer.bindings = applyBinding(peer.bindings, binding)
    for (const owned of [...this.#scopeOwners.keys()]) {
      if (this.#scopeOwners.get(owned) === peer.browserId && owned !== key && !(owned in peer.bindings)) {
        this.#scopeOwners.delete(owned)
      }
    }
    this.#scopeOwners.set(key, peer.browserId)
    this.#persist()
    this.#broadcastState()
  }

  /**
   * Drop one scope at the user's request.
   * @param peer - the browser.
   * @param frame - the remove frame.
   */
  #onBindingRemove(peer: BrowserPeer, frame: Record<string, unknown>): void {
    const scope = requireScope(frame)
    const key = scopeKey(scope.profileId, scope.sessionId)
    peer.bindings = removeScope(peer.bindings, scope)
    if (this.#scopeOwners.get(key) === peer.browserId) {
      this.#scopeOwners.delete(key)
      this.#persist()
    }
    this.#broadcastState()
  }

  /**
   * Accept one action result, but only if the routing that produced it is still true.
   *
   * This is the second half of exact routing. Between dispatch and result the user may have
   * re-attached the tab to another session or another Chrome profile; returning the payload anyway
   * would hand one session a page another session now owns.
   * @param peer - the browser answering.
   * @param frame - the result frame.
   */
  #onActionResult(peer: BrowserPeer, frame: Record<string, unknown>): void {
    const id = requireId(frame['id'], 'id')
    const action = this.#pending.get(id)
    if (!action || action.browser !== peer) return

    const owner = this.#scopeOwners.get(action.scopeKey)
    const binding = peer.bindings[action.scopeKey]
    const stillOwned = owner === peer.browserId && binding !== undefined
    const sameTarget = stillOwned
      && binding.activeTabId === action.targetTabId
      && binding.tabIds.includes(action.targetTabId)

    // Closing a scope's last tab legitimately removes the binding before the result travels back.
    // That one case may report close metadata, never page content.
    const closedLastTab = action.kind === 'close_tab' && owner === undefined && binding === undefined
    const mutatesBinding = BINDING_MUTATING_ACTIONS.has(action.kind)
    const authorized = mutatesBinding ? (stillOwned || closedLastTab) : sameTarget

    if (!authorized) {
      this.#settle(id, {
        code: ERROR.BINDING_CHANGED,
        message: 'the tab binding changed while the browser action was running',
      })
      return
    }

    if (frame['ok'] === true) this.#settle(id, undefined, frame['data'])
    else {
      const error = frame['error']
      const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
      this.#settle(id, {
        code: (typeof record['code'] === 'string' ? record['code'] : ERROR.ACTION_FAILED) as ErrorCode,
        message: displayText(record['message'], 'the browser could not perform the action', 400),
      })
    }
  }

  // -- agent frames ---------------------------------------------------------

  /**
   * Dispatch one frame from an authenticated DeepSeek Harness plugin.
   * @param peer - the agent.
   * @param type - the frame type.
   * @param frame - the frame body.
   */
  #handleAgent(peer: AgentPeer, type: string, frame: Record<string, unknown>): void {
    if (this.#agents.get(peer.agentId) !== peer) return

    switch (type) {
      case CLIENT.SESSION_ANNOUNCE: return this.#onSessionAnnounce(peer, frame)
      case CLIENT.SESSION_RETIRE: return this.#onSessionRetire(peer, frame)
      case CLIENT.ACTION_REQUEST: return this.#onActionRequest(peer, frame)
      case CLIENT.PONG: return
      default: throw new FrameError(ERROR.MALFORMED, `an agent may not send ${JSON.stringify(type)}`)
    }
  }

  /**
   * Record the sessions one plugin instance currently has live.
   * @param peer - the agent.
   * @param frame - the announcement frame.
   */
  #onSessionAnnounce(peer: AgentPeer, frame: Record<string, unknown>): void {
    const raw = frame['sessions']
    if (!Array.isArray(raw)) throw new FrameError(ERROR.MALFORMED, 'sessions must be an array')
    if (raw.length > LIMITS.MAX_SESSIONS_PER_AGENT) {
      throw new FrameError(ERROR.TOO_LARGE, 'too many sessions in one announcement')
    }
    const sessions = new Map<string, string>()
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) throw new FrameError(ERROR.MALFORMED, 'invalid session entry')
      const record = entry as Record<string, unknown>
      const sessionId = requireId(record['sessionId'], 'sessionId')
      sessions.set(sessionId, displayText(record['title'], sessionId))
    }
    peer.sessions = sessions
    this.#broadcastState()
  }

  /**
   * Remove one session that has ended.
   * @param peer - the agent.
   * @param frame - the retire frame.
   */
  #onSessionRetire(peer: AgentPeer, frame: Record<string, unknown>): void {
    peer.sessions.delete(requireId(frame['sessionId'], 'sessionId'))
    this.#broadcastState()
  }

  /**
   * Route one action to the exact tab its calling scope owns, or fail.
   *
   * There is no fallback target. A scope with no binding, or whose owning browser is not connected,
   * produces a typed failure and no browser is contacted at all.
   * @param peer - the requesting agent.
   * @param frame - the request frame.
   */
  #onActionRequest(peer: AgentPeer, frame: Record<string, unknown>): void {
    const requestId = requireId(frame['id'], 'id')
    const scope = requireScope(frame)
    const action = requireAction(frame['action'])

    if (scope.profileId !== peer.profileId) {
      this.#fail(peer, requestId, ERROR.UNAUTHENTICATED, 'an agent may act only in its own profile')
      return
    }
    if (peer.pendingIds.size >= LIMITS.MAX_PENDING_PER_AGENT) {
      this.#fail(peer, requestId, ERROR.TOO_LARGE, 'too many actions are already in flight')
      return
    }
    if (peer.pendingIds.has(requestId)) {
      this.#fail(peer, requestId, ERROR.MALFORMED, 'that request id is already in flight')
      return
    }

    const key = scopeKey(scope.profileId, scope.sessionId)
    const browserId = this.#scopeOwners.get(key)
    if (browserId === undefined) {
      this.#fail(peer, requestId, ERROR.NO_BINDING, 'this session has no attached tab; attach one in the connector panel')
      return
    }
    const browser = this.#browsers.get(browserId)
    if (!browser) {
      this.#fail(peer, requestId, ERROR.NO_BROWSER, 'the Chrome profile holding this session is not connected')
      return
    }
    const binding = lookup(browser.bindings, scope)
    if (!binding) {
      this.#fail(peer, requestId, ERROR.NO_BINDING, 'this session has no attached tab; attach one in the connector panel')
      return
    }
    if (browser.capabilities.size > 0 && !browser.capabilities.has(action.kind)) {
      this.#fail(peer, requestId, ERROR.UNSUPPORTED_ACTION, `this Chrome extension does not implement ${action.kind}`)
      return
    }

    const brokerId = `r${this.#nextRequestId++}`
    const timer = setTimeout(() => {
      // This timer is armed only after the action has been sent to the browser, so a timeout is
      // an unknown outcome, not a refusal: the page may have performed the action and lost the
      // answer. Saying only "did not answer" invited a caller to retry a payment or a submission.
      this.#settle(brokerId, {
        code: ERROR.TIMEOUT,
        message: 'the browser did not answer within the action deadline; it may have performed the action',
      })
    }, this.#actionTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    peer.pendingIds.add(requestId)
    this.#pending.set(brokerId, {
      agent: peer,
      agentRequestId: requestId,
      browser,
      scopeKey: key,
      targetTabId: binding.activeTabId,
      kind: action.kind,
      timer,
    })
    browser.socket.send({
      type: SERVER.ACTION,
      id: brokerId,
      scope: { profileId: scope.profileId, sessionId: scope.sessionId },
      targetTabId: binding.activeTabId,
      action: { kind: action.kind, args: action.args },
    })
  }

  // -- shared ---------------------------------------------------------------

  /**
   * Settle one pending action and answer the agent that asked for it.
   * @param brokerId - the broker's own request id.
   * @param error - the typed failure, or `undefined` on success.
   * @param data - the successful payload.
   */
  #settle(brokerId: string, error?: { code: ErrorCode, message: string }, data?: unknown): void {
    const action = this.#pending.get(brokerId)
    if (!action) return
    clearTimeout(action.timer)
    this.#pending.delete(brokerId)
    action.agent.pendingIds.delete(action.agentRequestId)
    if (this.#agents.get(action.agent.agentId) !== action.agent) return
    action.agent.socket.send(error
      ? { type: SERVER.ACTION_RESPONSE, id: action.agentRequestId, ok: false, error }
      : { type: SERVER.ACTION_RESPONSE, id: action.agentRequestId, ok: true, data: data ?? null })
  }

  /**
   * Answer one agent request that never reached a browser.
   * @param peer - the agent.
   * @param requestId - the agent's request id.
   * @param code - the typed reason.
   * @param message - human-readable detail.
   */
  #fail(peer: AgentPeer, requestId: string, code: ErrorCode, message: string): void {
    peer.socket.send({ type: SERVER.ACTION_RESPONSE, id: requestId, ok: false, error: { code, message } })
  }

  /**
   * Tell one browser it no longer holds a scope.
   * @param peer - the browser losing the scope.
   * @param scope - the scope.
   * @param reason - what to show the user.
   */
  #revoke(peer: BrowserPeer, scope: Scope, reason: string): void {
    peer.socket.send({
      type: SERVER.BINDING_REVOKED,
      profileId: scope.profileId,
      sessionId: scope.sessionId,
      reason,
    })
  }

  /**
   * Answer a frame that failed validation.
   *
   * An unauthenticated peer is closed, because nothing it can send afterwards is meaningful. An
   * authenticated peer is told and kept, because one malformed frame is not grounds to drop a
   * working browser.
   * @param socket - the offending connection.
   * @param cause - what validation threw.
   */
  #reject(socket: PeerSocket, cause: unknown): void {
    const code = cause instanceof FrameError ? cause.code : ERROR.INTERNAL
    const message = cause instanceof Error ? cause.message : 'unhandled frame'
    socket.send({ type: SERVER.DENIED, code, message })
    if (!this.#peersBySocket.has(socket)) {
      this.#pendingPeers.delete(socket)
      socket.close(1008, code)
    }
  }

  /** Persist the scope-to-browser preference. */
  #persist(): void {
    this.#store.save({ scopeOwners: Object.fromEntries(this.#scopeOwners) })
  }

  /** Send every connected peer the current state projection. */
  #broadcastState(): void {
    const browsers = [...this.#browsers.values()].map((peer) => ({
      browserId: peer.browserId,
      name: peer.name,
      bindings: bindingList(peer.bindings),
    }))
    const sessions = this.sessions()
    const frame = { type: SERVER.STATE, brokerVersion: this.#version, browsers, sessions }
    for (const peer of this.#peersBySocket.values()) peer.socket.send(frame)
  }
}
