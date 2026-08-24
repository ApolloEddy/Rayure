import {
  createClientHello,
  createClientMotionPlayback,
  createClientSpeechPlayback,
  parseServerMessage,
  serializeWireMessage,
} from '@rayure/protocol'
import type {
  ModelDescriptor,
  MotionPlaybackPhase,
  MotionDescriptor,
  SpeechDescriptor,
  SpeechPlaybackPhase,
  ServerEmotePlayMessage,
  ServerExpressionResetMessage,
  ServerExpressionSetMessage,
} from '@rayure/protocol'

export type CompanionConnectionPhase =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

export interface CompanionConnectionSnapshot {
  phase: CompanionConnectionPhase
  port: number
  attempt: number
  detail?: string
}

export interface CompanionMotionPlaybackReport {
  motionId: string
  phase: MotionPlaybackPhase
  frameIndex: number
}

export interface CompanionSpeechPlaybackReport {
  speechId: string
  phase: SpeechPlaybackPhase
  timeMs: number
}

export interface CompanionClientOptions {
  port: number
  build: string
  onStatus?: (snapshot: CompanionConnectionSnapshot) => void
  onModelAvailable?: (model: ModelDescriptor) => void
  onMotionCatalog?: (motions: readonly MotionDescriptor[]) => void
  onMotionPublished?: (motion: MotionDescriptor) => void
  onSpeechPublished?: (speech: SpeechDescriptor) => void
  onMotionPlay?: (motion: MotionDescriptor) => void
  onMotionStop?: (motionId?: string) => void
  onExpressionSet?: (payload: ServerExpressionSetMessage['payload']) => void
  onExpressionReset?: (payload?: ServerExpressionResetMessage['payload']) => void
  onEmotePlay?: (payload: ServerEmotePlayMessage['payload']) => void
  webSocketFactory?: (url: string) => WebSocket
  createId?: () => string
}

const MAX_RECONNECT_DELAY_MS = 10_000

export class CompanionClient {
  readonly #build: string
  readonly #onStatus: ((snapshot: CompanionConnectionSnapshot) => void) | undefined
  readonly #webSocketFactory: (url: string) => WebSocket
  readonly #createId: () => string
  readonly #onModelAvailable: ((model: ModelDescriptor) => void) | undefined
  readonly #onMotionCatalog: ((motions: readonly MotionDescriptor[]) => void) | undefined
  readonly #onMotionPublished: ((motion: MotionDescriptor) => void) | undefined
  readonly #onSpeechPublished: ((speech: SpeechDescriptor) => void) | undefined
  readonly #onMotionPlay: ((motion: MotionDescriptor) => void) | undefined
  readonly #onMotionStop: ((motionId?: string) => void) | undefined
  readonly #onExpressionSet: ((payload: ServerExpressionSetMessage['payload']) => void) | undefined
  readonly #onExpressionReset: ((payload?: ServerExpressionResetMessage['payload']) => void) | undefined
  readonly #onEmotePlay: ((payload: ServerEmotePlayMessage['payload']) => void) | undefined
  #port: number
  #socket: WebSocket | undefined
  #reconnectTimer: number | undefined
  #generation = 0
  #attempt = 0
  #started = false
  #phase: CompanionConnectionPhase = 'stopped'
  #detail: string | undefined

  constructor(options: CompanionClientOptions) {
    this.#port = options.port
    this.#build = options.build
    this.#onStatus = options.onStatus
    this.#webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url))
    this.#createId = options.createId ?? createWireId
    this.#onModelAvailable = options.onModelAvailable
    this.#onMotionCatalog = options.onMotionCatalog
    this.#onMotionPublished = options.onMotionPublished
    this.#onSpeechPublished = options.onSpeechPublished
    this.#onMotionPlay = options.onMotionPlay
    this.#onMotionStop = options.onMotionStop
    this.#onExpressionSet = options.onExpressionSet
    this.#onExpressionReset = options.onExpressionReset
    this.#onEmotePlay = options.onEmotePlay
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#attempt = 0
    this.#connect()
  }

  setPort(port: number): void {
    if (port === this.#port) return
    this.#port = port
    this.#attempt = 0
    if (!this.#started) {
      this.#emit('stopped')
      return
    }
    this.#replaceConnection()
  }

  stop(): void {
    if (!this.#started && this.#phase === 'stopped') return
    this.#started = false
    this.#generation += 1
    this.#clearReconnectTimer()
    const socket = this.#socket
    this.#socket = undefined
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, 'Wallpaper client stopped')
    }
    this.#emit('stopped')
  }

  snapshot(): CompanionConnectionSnapshot {
    return {
      phase: this.#phase,
      port: this.#port,
      attempt: this.#attempt,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    }
  }

  /**
   * Sends renderer-observed progress for a generated motion. This is best
   * effort by design: a reconnect must never stall rendering or replay stale
   * telemetry against a later Companion session.
   */
  reportMotionPlayback(report: CompanionMotionPlaybackReport): boolean {
    const socket = this.#socket
    if (
      !this.#started
      || this.#phase !== 'connected'
      || socket === undefined
      || socket.readyState !== WebSocket.OPEN
    ) return false
    try {
      socket.send(serializeWireMessage(createClientMotionPlayback({
        id: this.#createId(),
        motionId: report.motionId,
        phase: report.phase,
        frameIndex: report.frameIndex,
      })))
      return true
    }
    catch {
      return false
    }
  }

  /** Best-effort renderer telemetry for a tokenized speech resource. */
  reportSpeechPlayback(report: CompanionSpeechPlaybackReport): boolean {
    const socket = this.#socket
    if (!this.#started || this.#phase !== 'connected' || socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(serializeWireMessage(createClientSpeechPlayback({
        id: this.#createId(),
        speechId: report.speechId,
        phase: report.phase,
        timeMs: report.timeMs,
      })))
      return true
    }
    catch {
      return false
    }
  }

  #replaceConnection(): void {
    this.#generation += 1
    this.#clearReconnectTimer()
    const previous = this.#socket
    this.#socket = undefined
    if (previous && (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING)) {
      previous.close(1000, 'Companion endpoint changed')
    }
    this.#connect()
  }

  #connect(): void {
    if (!this.#started) return
    const generation = ++this.#generation
    const helloId = this.#createId()
    this.#attempt += 1
    this.#emit(this.#attempt === 1 ? 'connecting' : 'retrying')

    let socket: WebSocket
    try {
      socket = this.#webSocketFactory(`ws://127.0.0.1:${this.#port}/ws`)
    }
    catch (cause) {
      this.#emit('error', toErrorMessage(cause))
      this.#scheduleReconnect(generation)
      return
    }
    this.#socket = socket
    let welcomed = false

    socket.addEventListener('open', () => {
      if (!this.#isCurrent(generation, socket)) return
      try {
        socket.send(serializeWireMessage(createClientHello({ id: helloId, build: this.#build })))
      }
      catch (cause) {
        this.#emit('error', toErrorMessage(cause))
        socket.close(1008, 'Client hello failed')
      }
    })

    socket.addEventListener('message', (event) => {
      if (!this.#isCurrent(generation, socket) || typeof event.data !== 'string') return
      try {
        const message = parseServerMessage(event.data)
        if (message.type === 'server.error') {
          this.#emit('error', message.payload.message)
          socket.close(1008, 'Companion rejected the session')
          return
        }
        if (message.type === 'server.welcome') {
          if (welcomed) throw new Error('Companion sent a duplicate welcome')
          if (message.replyTo !== helloId) throw new Error('Companion welcome did not match this handshake')
          welcomed = true
          this.#attempt = 0
          this.#emit('connected')
          return
        }
        if (message.type === 'model.available') {
          if (!welcomed) throw new Error('Companion announced a model before completing the handshake')
          try {
            this.#onModelAvailable?.(message.payload.model)
          }
          catch {
            // A renderer callback cannot own or corrupt the transport lifecycle.
          }
          return
        }

        if (message.type === 'motion.catalog') {
          if (!welcomed) throw new Error('Companion announced motion catalog before completing the handshake')
          try {
            this.#onMotionCatalog?.(message.payload.motions)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'motion.published') {
          if (!welcomed) throw new Error('Companion published motion before completing the handshake')
          try {
            this.#onMotionPublished?.(message.payload.motion)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'speech.published') {
          if (!welcomed) throw new Error('Companion published speech before completing the handshake')
          try {
            this.#onSpeechPublished?.(message.payload.speech)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'emote.play') {
          if (!welcomed) throw new Error('Companion sent emote before completing the handshake')
          try {
            this.#onEmotePlay?.(message.payload)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'motion.play') {
          if (!welcomed) throw new Error('Companion sent motion before completing the handshake')
          try {
            this.#onMotionPlay?.(message.payload.motion)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'motion.stop') {
          if (!welcomed) throw new Error('Companion sent motion stop before completing the handshake')
          try {
            this.#onMotionStop?.(message.payload?.motionId)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'expression.set') {
          if (!welcomed) throw new Error('Companion sent expression before completing the handshake')
          try {
            this.#onExpressionSet?.(message.payload)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }

        if (message.type === 'expression.reset') {
          if (!welcomed) throw new Error('Companion sent expression reset before completing the handshake')
          try {
            this.#onExpressionReset?.(message.payload)
          }
          catch {
            // Transport lifecycle isolation.
          }
          return
        }
      }
      catch (cause) {
        this.#emit('error', toErrorMessage(cause))
        socket.close(1008, 'Invalid companion response')
      }
    })

    socket.addEventListener('close', () => {
      if (!this.#isCurrent(generation, socket)) return
      this.#socket = undefined
      if (this.#started) this.#scheduleReconnect(generation)
    })

    socket.addEventListener('error', () => {
      if (!this.#isCurrent(generation, socket)) return
      this.#emit('error', 'Companion connection failed')
    })
  }

  #scheduleReconnect(generation: number): void {
    if (!this.#started || generation !== this.#generation || this.#reconnectTimer !== undefined) return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(this.#attempt - 1, 5))
    this.#emit('retrying', `Retrying in ${Math.round(delay / 100) / 10}s`)
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = undefined
      if (this.#started && generation === this.#generation) this.#connect()
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    window.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #isCurrent(generation: number, socket: WebSocket): boolean {
    return this.#started && generation === this.#generation && socket === this.#socket
  }

  #emit(phase: CompanionConnectionPhase, detail?: string): void {
    this.#phase = phase
    this.#detail = detail
    try {
      this.#onStatus?.(this.snapshot())
    }
    catch {
      // Presentation diagnostics cannot own the connection lifecycle.
    }
  }
}

function createWireId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const values = new Uint32Array(4)
  crypto.getRandomValues(values)
  return `wallpaper-${[...values].map(value => value.toString(16).padStart(8, '0')).join('')}`
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
