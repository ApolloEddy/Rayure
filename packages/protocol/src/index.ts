export * from './canonical-motion.ts'
export * from './motion-semantic-feature.ts'
export * from './speech.ts'

import {
  speechAudioMimeTypes,
  speechPlaybackPhases,
} from './speech.ts'
import type {
  SpeechAudioMimeType,
  SpeechDescriptor,
  SpeechPlaybackPhase,
} from './speech.ts'

export const PROTOCOL_VERSION = 1 as const
export const MAX_WIRE_MESSAGE_BYTES = 16 * 1024

export const companionCapabilities = [
  'lifecycle.status',
  'model.catalog',
  'motion.catalog',
  'motion.generate',
  'motion.playback',
  'speech.output',
  'expression.control',
] as const
export type CompanionCapability = typeof companionCapabilities[number]

export interface ClientHelloMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'client.hello'
  id: string
  payload: {
    client: 'wallpaper'
    build: string
  }
}

/**
 * Renderer-to-Companion playback telemetry.  The renderer reports completed
 * source frames rather than wall-clock time so a downstream generator can
 * continue from an actually visible pose without assuming its own frame
 * timing matches the display refresh rate.
 */
export const motionPlaybackPhases = [
  'started',
  'progress',
  'completed',
  'cancelled',
] as const
export type MotionPlaybackPhase = typeof motionPlaybackPhases[number]

export interface ClientMotionPlaybackMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.playback'
  id: string
  payload: {
    motionId: string
    phase: MotionPlaybackPhase
    frameIndex: number
  }
}

/** Renderer-side developer request for one ARDY Canonical Motion segment. */
export interface ClientMotionGenerateMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.generate'
  id: string
  payload: {
    prompt: string
    numFrames?: number
    numDenoisingSteps?: number
    cfgWeight?: number
  }
}

export const motionGenerationStatusPhases = ['accepted', 'failed'] as const
export type MotionGenerationStatusPhase = typeof motionGenerationStatusPhases[number]

export interface ServerMotionGenerateStatusMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.generate.status'
  id: string
  replyTo: string
  payload: {
    phase: MotionGenerationStatusPhase
    message?: string
  }
}

export interface ClientSpeechPlaybackMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'speech.playback'
  id: string
  payload: {
    speechId: string
    phase: SpeechPlaybackPhase
    timeMs: number
  }
}

export interface ServerWelcomeMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'server.welcome'
  id: string
  replyTo: string
  payload: {
    connectionId: string
    serverTimeMs: number
    capabilities: readonly CompanionCapability[]
  }
}

export type ServerErrorCode =
  | 'invalid_message'
  | 'hello_timeout'
  | 'duplicate_hello'
  | 'internal_error'

export interface ServerErrorMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'server.error'
  id: string
  replyTo?: string
  payload: {
    code: ServerErrorCode
    message: string
  }
}

export interface ModelDescriptor {
  id: string
  displayName: string
  format: 'pmx' | 'live2d'
  url: string
  /** Optional full Live2D entry used only when model-native content is explicitly imported. */
  nativeUrl?: string
  /** Source-scene parts hidden in the default skin-only view. */
  skinHiddenPartIds?: readonly string[]
}

export interface ServerModelAvailableMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'model.available'
  id: string
  payload: {
    model: ModelDescriptor
  }
}

interface MotionDescriptorBase {
  id: string
  displayName: string
  url: string
  loop?: boolean
}

export interface VmdMotionDescriptor extends MotionDescriptorBase {
  format: 'vmd'
}

export interface Live2dMotionDescriptor extends MotionDescriptorBase {
  format: 'live2d'
  group: string
  index: number
}

/**
 * A tokenized reference to a generated `rayure.motion.v1` (Canonical Motion).
 * The large frame data is never put on the 16 KiB Companion websocket; it is
 * served by the loopback asset gateway and only its descriptor is published.
 */
export interface CanonicalMotionDescriptor extends MotionDescriptorBase {
  format: 'canonical'
}

export type MotionDescriptor = VmdMotionDescriptor | Live2dMotionDescriptor | CanonicalMotionDescriptor

export interface ServerMotionPlayMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.play'
  id: string
  payload: {
    motion: MotionDescriptor
  }
}

export interface ServerMotionStopMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.stop'
  id: string
  payload?: {
    motionId?: string
  }
}

export interface ServerExpressionSetMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'expression.set'
  id: string
  payload: {
    name: string
    weight: number
    durationMs?: number
  }
}

export interface ServerExpressionResetMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'expression.reset'
  id: string
  payload?: {
    durationMs?: number
  }
}

export interface ServerMotionCatalogMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.catalog'
  id: string
  payload: {
    motions: readonly MotionDescriptor[]
  }
}

export interface ServerMotionPublishedMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'motion.published'
  id: string
  payload: {
    motion: MotionDescriptor
  }
}

export interface ServerSpeechPublishedMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'speech.published'
  id: string
  payload: {
    speech: SpeechDescriptor
  }
}

export interface ServerEmotePlayMessage {
  protocolVersion: typeof PROTOCOL_VERSION
  type: 'emote.play'
  id: string
  payload: {
    emoteId: string
    motionId?: string
    expressionName?: string
    expressionWeight?: number
    durationMs?: number
  }
}

export type ClientMessage = ClientHelloMessage | ClientMotionGenerateMessage | ClientMotionPlaybackMessage | ClientSpeechPlaybackMessage
export type ServerMessage =
  | ServerWelcomeMessage
  | ServerErrorMessage
  | ServerModelAvailableMessage
  | ServerMotionCatalogMessage
  | ServerMotionGenerateStatusMessage
  | ServerMotionPublishedMessage
  | ServerSpeechPublishedMessage
  | ServerMotionPlayMessage
  | ServerMotionStopMessage
  | ServerExpressionSetMessage
  | ServerExpressionResetMessage
  | ServerEmotePlayMessage

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolValidationError'
  }
}

export function createClientHello(input: { id: string, build: string }): ClientHelloMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'client.hello',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      client: 'wallpaper',
      build: requireDisplayString(input.build, 'build', 64),
    },
  }
}

export function createClientMotionPlayback(input: {
  id: string
  motionId: string
  phase: MotionPlaybackPhase
  frameIndex: number
}): ClientMotionPlaybackMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.playback',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      motionId: requireIdentifier(input.motionId, 'motionId'),
      phase: requireMotionPlaybackPhase(input.phase),
      frameIndex: requireInteger(input.frameIndex, 'frameIndex', 0, 600),
    },
  }
}

export function createClientMotionGenerate(input: {
  id: string
  prompt: string
  numFrames?: number
  numDenoisingSteps?: number
  cfgWeight?: number
}): ClientMotionGenerateMessage {
  const payload: ClientMotionGenerateMessage['payload'] = {
    prompt: requireDisplayString(input.prompt, 'motion generate prompt', 512),
  }
  if (input.numFrames !== undefined) payload.numFrames = requireInteger(input.numFrames, 'motion generate numFrames', 1, 600)
  if (input.numDenoisingSteps !== undefined) {
    payload.numDenoisingSteps = requireInteger(input.numDenoisingSteps, 'motion generate numDenoisingSteps', 1, 20)
  }
  if (input.cfgWeight !== undefined) payload.cfgWeight = requireFiniteNumber(input.cfgWeight, 'motion generate cfgWeight', 0, 20)
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.generate',
    id: requireIdentifier(input.id, 'id'),
    payload,
  }
}

export function createClientSpeechPlayback(input: {
  id: string
  speechId: string
  phase: SpeechPlaybackPhase
  timeMs: number
}): ClientSpeechPlaybackMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'speech.playback',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      speechId: requireIdentifier(input.speechId, 'speechId'),
      phase: requireSpeechPlaybackPhase(input.phase),
      timeMs: requireInteger(input.timeMs, 'timeMs', 0, 600_000),
    },
  }
}

export function createServerWelcome(input: {
  id: string
  replyTo: string
  connectionId: string
  serverTimeMs: number
  capabilities?: readonly CompanionCapability[]
}): ServerWelcomeMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'server.welcome',
    id: requireIdentifier(input.id, 'id'),
    replyTo: requireIdentifier(input.replyTo, 'replyTo'),
    payload: {
      connectionId: requireIdentifier(input.connectionId, 'connectionId'),
      serverTimeMs: requireTimestamp(input.serverTimeMs),
      capabilities: requireCapabilities(input.capabilities ?? companionCapabilities),
    },
  }
}

export function createServerError(input: {
  id: string
  replyTo?: string
  code: ServerErrorCode
  message: string
}): ServerErrorMessage {
  const result: ServerErrorMessage = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'server.error',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      code: requireErrorCode(input.code),
      message: requireDisplayString(input.message, 'message', 160),
    },
  }
  if (input.replyTo !== undefined) result.replyTo = requireIdentifier(input.replyTo, 'replyTo')
  return result
}

export function createServerModelAvailable(input: {
  id: string
  model: ModelDescriptor
}): ServerModelAvailableMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'model.available',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      model: requireModelDescriptor(input.model),
    },
  }
}

export function createServerMotionPlay(input: {
  id: string
  motion: MotionDescriptor
}): ServerMotionPlayMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.play',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      motion: requireMotionDescriptor(input.motion),
    },
  }
}

export function createServerMotionStop(input: {
  id: string
  motionId?: string
}): ServerMotionStopMessage {
  const result: ServerMotionStopMessage = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.stop',
    id: requireIdentifier(input.id, 'id'),
  }
  if (input.motionId !== undefined) {
    result.payload = {
      motionId: requireIdentifier(input.motionId, 'motionId'),
    }
  }
  return result
}

export function createServerExpressionSet(input: {
  id: string
  name: string
  weight: number
  durationMs?: number
}): ServerExpressionSetMessage {
  const payload: ServerExpressionSetMessage['payload'] = {
    name: requireDisplayString(input.name, 'expression name', 64),
    weight: requireWeight(input.weight),
  }
  if (input.durationMs !== undefined) {
    payload.durationMs = requireDurationMs(input.durationMs)
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'expression.set',
    id: requireIdentifier(input.id, 'id'),
    payload,
  }
}

export function createServerExpressionReset(input: {
  id: string
  durationMs?: number
}): ServerExpressionResetMessage {
  const result: ServerExpressionResetMessage = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'expression.reset',
    id: requireIdentifier(input.id, 'id'),
  }
  if (input.durationMs !== undefined) {
    result.payload = {
      durationMs: requireDurationMs(input.durationMs),
    }
  }
  return result
}

export function createServerMotionCatalog(input: {
  id: string
  motions: readonly MotionDescriptor[]
}): ServerMotionCatalogMessage {
  if (!Array.isArray(input.motions)) {
    throw new ProtocolValidationError('motions must be an array')
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.catalog',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      motions: input.motions.map(requireMotionDescriptor),
    },
  }
}

export function createServerMotionPublished(input: {
  id: string
  motion: MotionDescriptor
}): ServerMotionPublishedMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.published',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      motion: requireMotionDescriptor(input.motion),
    },
  }
}

export function createServerMotionGenerateStatus(input: {
  id: string
  replyTo: string
  phase: MotionGenerationStatusPhase
  message?: string
}): ServerMotionGenerateStatusMessage {
  const payload: ServerMotionGenerateStatusMessage['payload'] = {
    phase: requireMotionGenerationStatusPhase(input.phase),
  }
  if (input.message !== undefined) payload.message = requireDisplayString(input.message, 'motion generate status message', 160)
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.generate.status',
    id: requireIdentifier(input.id, 'id'),
    replyTo: requireIdentifier(input.replyTo, 'replyTo'),
    payload,
  }
}

export function createServerSpeechPublished(input: {
  id: string
  speech: SpeechDescriptor
}): ServerSpeechPublishedMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'speech.published',
    id: requireIdentifier(input.id, 'id'),
    payload: {
      speech: requireSpeechDescriptor(input.speech),
    },
  }
}

export function createServerEmotePlay(input: {
  id: string
  emoteId: string
  motionId?: string
  expressionName?: string
  expressionWeight?: number
  durationMs?: number
}): ServerEmotePlayMessage {
  const payload: ServerEmotePlayMessage['payload'] = {
    emoteId: requireIdentifier(input.emoteId, 'emoteId'),
  }
  if (input.motionId !== undefined) {
    payload.motionId = requireIdentifier(input.motionId, 'motionId')
  }
  if (input.expressionName !== undefined) {
    payload.expressionName = requireDisplayString(input.expressionName, 'expressionName', 64)
  }
  if (input.expressionWeight !== undefined) {
    payload.expressionWeight = requireWeight(input.expressionWeight)
  }
  if (input.durationMs !== undefined) {
    payload.durationMs = requireDurationMs(input.durationMs)
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'emote.play',
    id: requireIdentifier(input.id, 'id'),
    payload,
  }
}

export function parseClientMessage(raw: string): ClientMessage {
  const value = parseWireObject(raw)
  requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'client message')
  requireProtocolVersion(value.protocolVersion)
  if (value.type === 'client.hello') {
    const payload = requireRecord(value.payload, 'client hello payload')
    requireExactKeys(payload, ['client', 'build'], 'client hello payload')
    if (payload.client !== 'wallpaper') throw new ProtocolValidationError('client must be wallpaper')

    return createClientHello({
      id: requireIdentifier(value.id, 'id'),
      build: requireDisplayString(payload.build, 'build', 64),
    })
  }

  if (value.type === 'motion.playback') {
    const payload = requireRecord(value.payload, 'motion playback payload')
    requireExactKeys(payload, ['motionId', 'phase', 'frameIndex'], 'motion playback payload')
    return createClientMotionPlayback({
      id: requireIdentifier(value.id, 'id'),
      motionId: requireIdentifier(payload.motionId, 'motionId'),
      phase: requireMotionPlaybackPhase(payload.phase),
      frameIndex: requireInteger(payload.frameIndex, 'frameIndex', 0, 600),
    })
  }

  if (value.type === 'motion.generate') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'motion generate')
    const payload = requireRecord(value.payload, 'motion generate payload')
    const expectedKeys = ['prompt']
    if (payload.numFrames !== undefined) expectedKeys.push('numFrames')
    if (payload.numDenoisingSteps !== undefined) expectedKeys.push('numDenoisingSteps')
    if (payload.cfgWeight !== undefined) expectedKeys.push('cfgWeight')
    requireExactKeys(payload, expectedKeys, 'motion generate payload')
    return createClientMotionGenerate({
      id: requireIdentifier(value.id, 'id'),
      prompt: requireDisplayString(payload.prompt, 'motion generate prompt', 512),
      ...(payload.numFrames === undefined ? {} : { numFrames: requireInteger(payload.numFrames, 'motion generate numFrames', 1, 600) }),
      ...(payload.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: requireInteger(payload.numDenoisingSteps, 'motion generate numDenoisingSteps', 1, 20) }),
      ...(payload.cfgWeight === undefined ? {} : { cfgWeight: requireFiniteNumber(payload.cfgWeight, 'motion generate cfgWeight', 0, 20) }),
    })
  }

  if (value.type === 'speech.playback') {
    const payload = requireRecord(value.payload, 'speech playback payload')
    requireExactKeys(payload, ['speechId', 'phase', 'timeMs'], 'speech playback payload')
    return createClientSpeechPlayback({
      id: requireIdentifier(value.id, 'id'),
      speechId: requireIdentifier(payload.speechId, 'speechId'),
      phase: requireSpeechPlaybackPhase(payload.phase),
      timeMs: requireInteger(payload.timeMs, 'timeMs', 0, 600_000),
    })
  }

  throw new ProtocolValidationError('Unsupported client message type')
}

export function parseServerMessage(raw: string): ServerMessage {
  const value = parseWireObject(raw)
  requireProtocolVersion(value.protocolVersion)

  if (value.type === 'server.welcome') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'replyTo', 'payload'], 'server welcome')
    const payload = requireRecord(value.payload, 'server welcome payload')
    requireExactKeys(payload, ['connectionId', 'serverTimeMs', 'capabilities'], 'server welcome payload')
    return createServerWelcome({
      id: requireIdentifier(value.id, 'id'),
      replyTo: requireIdentifier(value.replyTo, 'replyTo'),
      connectionId: requireIdentifier(payload.connectionId, 'connectionId'),
      serverTimeMs: requireTimestamp(payload.serverTimeMs),
      capabilities: requireCapabilities(payload.capabilities),
    })
  }

  if (value.type === 'server.error') {
    requireExactKeys(
      value,
      value.replyTo === undefined
        ? ['protocolVersion', 'type', 'id', 'payload']
        : ['protocolVersion', 'type', 'id', 'replyTo', 'payload'],
      'server error',
    )
    const payload = requireRecord(value.payload, 'server error payload')
    requireExactKeys(payload, ['code', 'message'], 'server error payload')
    return createServerError({
      id: requireIdentifier(value.id, 'id'),
      ...(value.replyTo === undefined ? {} : { replyTo: requireIdentifier(value.replyTo, 'replyTo') }),
      code: requireErrorCode(payload.code),
      message: requireDisplayString(payload.message, 'message', 160),
    })
  }

  if (value.type === 'model.available') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'model available')
    const payload = requireRecord(value.payload, 'model available payload')
    requireExactKeys(payload, ['model'], 'model available payload')
    return createServerModelAvailable({
      id: requireIdentifier(value.id, 'id'),
      model: requireModelDescriptor(payload.model),
    })
  }

  if (value.type === 'motion.play') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'motion play')
    const payload = requireRecord(value.payload, 'motion play payload')
    requireExactKeys(payload, ['motion'], 'motion play payload')
    return createServerMotionPlay({
      id: requireIdentifier(value.id, 'id'),
      motion: requireMotionDescriptor(payload.motion),
    })
  }

  if (value.type === 'motion.stop') {
    if (value.payload !== undefined) {
      requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'motion stop')
      const payload = requireRecord(value.payload, 'motion stop payload')
      if (payload.motionId !== undefined) {
        requireExactKeys(payload, ['motionId'], 'motion stop payload')
        return createServerMotionStop({
          id: requireIdentifier(value.id, 'id'),
          motionId: requireIdentifier(payload.motionId, 'motionId'),
        })
      }
      requireExactKeys(payload, [], 'motion stop payload')
    }
    else {
      requireExactKeys(value, ['protocolVersion', 'type', 'id'], 'motion stop')
    }
    return createServerMotionStop({
      id: requireIdentifier(value.id, 'id'),
    })
  }

  if (value.type === 'expression.set') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'expression set')
    const payload = requireRecord(value.payload, 'expression set payload')
    const expectedKeys = payload.durationMs !== undefined ? ['name', 'weight', 'durationMs'] : ['name', 'weight']
    requireExactKeys(payload, expectedKeys, 'expression set payload')
    return createServerExpressionSet({
      id: requireIdentifier(value.id, 'id'),
      name: requireDisplayString(payload.name, 'expression name', 64),
      weight: requireWeight(payload.weight),
      ...(payload.durationMs !== undefined ? { durationMs: requireDurationMs(payload.durationMs) } : {}),
    })
  }

  if (value.type === 'expression.reset') {
    if (value.payload !== undefined) {
      requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'expression reset')
      const payload = requireRecord(value.payload, 'expression reset payload')
      if (payload.durationMs !== undefined) {
        requireExactKeys(payload, ['durationMs'], 'expression reset payload')
        return createServerExpressionReset({
          id: requireIdentifier(value.id, 'id'),
          durationMs: requireDurationMs(payload.durationMs),
        })
      }
      requireExactKeys(payload, [], 'expression reset payload')
    }
    else {
      requireExactKeys(value, ['protocolVersion', 'type', 'id'], 'expression reset')
    }
    return createServerExpressionReset({
      id: requireIdentifier(value.id, 'id'),
    })
  }

  if (value.type === 'motion.catalog') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'motion catalog')
    const payload = requireRecord(value.payload, 'motion catalog payload')
    requireExactKeys(payload, ['motions'], 'motion catalog payload')
    if (!Array.isArray(payload.motions)) {
      throw new ProtocolValidationError('motions must be an array')
    }
    return createServerMotionCatalog({
      id: requireIdentifier(value.id, 'id'),
      motions: payload.motions.map(requireMotionDescriptor),
    })
  }

  if (value.type === 'motion.published') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'motion published')
    const payload = requireRecord(value.payload, 'motion published payload')
    requireExactKeys(payload, ['motion'], 'motion published payload')
    return createServerMotionPublished({
      id: requireIdentifier(value.id, 'id'),
      motion: requireMotionDescriptor(payload.motion),
    })
  }

  if (value.type === 'motion.generate.status') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'replyTo', 'payload'], 'motion generate status')
    const payload = requireRecord(value.payload, 'motion generate status payload')
    const expectedKeys = ['phase']
    if (payload.message !== undefined) expectedKeys.push('message')
    requireExactKeys(payload, expectedKeys, 'motion generate status payload')
    return createServerMotionGenerateStatus({
      id: requireIdentifier(value.id, 'id'),
      replyTo: requireIdentifier(value.replyTo, 'replyTo'),
      phase: requireMotionGenerationStatusPhase(payload.phase),
      ...(payload.message === undefined ? {} : { message: requireDisplayString(payload.message, 'motion generate status message', 160) }),
    })
  }

  if (value.type === 'speech.published') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'speech published')
    const payload = requireRecord(value.payload, 'speech published payload')
    requireExactKeys(payload, ['speech'], 'speech published payload')
    return createServerSpeechPublished({
      id: requireIdentifier(value.id, 'id'),
      speech: requireSpeechDescriptor(payload.speech),
    })
  }

  if (value.type === 'emote.play') {
    requireExactKeys(value, ['protocolVersion', 'type', 'id', 'payload'], 'emote play')
    const payload = requireRecord(value.payload, 'emote play payload')
    const expectedKeys = ['emoteId']
    if (payload.motionId !== undefined) expectedKeys.push('motionId')
    if (payload.expressionName !== undefined) expectedKeys.push('expressionName')
    if (payload.expressionWeight !== undefined) expectedKeys.push('expressionWeight')
    if (payload.durationMs !== undefined) expectedKeys.push('durationMs')
    requireExactKeys(payload, expectedKeys, 'emote play payload')

    return createServerEmotePlay({
      id: requireIdentifier(value.id, 'id'),
      emoteId: requireIdentifier(payload.emoteId, 'emoteId'),
      ...(payload.motionId !== undefined ? { motionId: requireIdentifier(payload.motionId, 'motionId') } : {}),
      ...(payload.expressionName !== undefined ? { expressionName: requireDisplayString(payload.expressionName, 'expressionName', 64) } : {}),
      ...(payload.expressionWeight !== undefined ? { expressionWeight: requireWeight(payload.expressionWeight) } : {}),
      ...(payload.durationMs !== undefined ? { durationMs: requireDurationMs(payload.durationMs) } : {}),
    })
  }

  throw new ProtocolValidationError('Unsupported server message type')
}

export function serializeWireMessage(message: ClientMessage | ServerMessage): string {
  const raw = JSON.stringify(message)
  requireWireSize(raw)
  return raw
}

function parseWireObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new ProtocolValidationError('Wire message must be text')
  requireWireSize(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new ProtocolValidationError('Wire message must be valid JSON')
  }
  return requireRecord(parsed, 'wire message')
}

function requireWireSize(raw: string): void {
  if (new TextEncoder().encode(raw).byteLength > MAX_WIRE_MESSAGE_BYTES) {
    throw new ProtocolValidationError('Message exceeds maximum wire size')
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolValidationError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new ProtocolValidationError(`${name} contains missing or unknown fields`)
  }
}

function requireProtocolVersion(value: unknown): asserts value is typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolValidationError('Unsupported protocol version')
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) {
    throw new ProtocolValidationError(`${name} must be a 1-64 character wire identifier`)
  }
  return value
}

function requireDisplayString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new ProtocolValidationError(`${name} must be a trimmed printable string up to ${maxLength} characters`)
  }
  return value
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolValidationError('serverTimeMs must be a non-negative safe integer')
  }
  return value
}

function requireCapabilities(value: unknown): readonly CompanionCapability[] {
  if (!Array.isArray(value)) throw new ProtocolValidationError('capabilities must be an array')
  const allowed = new Set<string>(companionCapabilities)
  const result: CompanionCapability[] = []
  for (const capability of value) {
    if (typeof capability !== 'string' || !allowed.has(capability)) {
      throw new ProtocolValidationError('capabilities contains an unsupported capability')
    }
    if (result.includes(capability as CompanionCapability)) {
      throw new ProtocolValidationError('capabilities must not contain duplicates')
    }
    result.push(capability as CompanionCapability)
  }
  return result
}

function requireMotionPlaybackPhase(value: unknown): MotionPlaybackPhase {
  if (typeof value !== 'string' || !motionPlaybackPhases.includes(value as MotionPlaybackPhase)) {
    throw new ProtocolValidationError('motion playback phase is invalid')
  }
  return value as MotionPlaybackPhase
}

function requireMotionGenerationStatusPhase(value: unknown): MotionGenerationStatusPhase {
  if (typeof value !== 'string' || !motionGenerationStatusPhases.includes(value as MotionGenerationStatusPhase)) {
    throw new ProtocolValidationError('motion generation status phase is invalid')
  }
  return value as MotionGenerationStatusPhase
}

function requireSpeechPlaybackPhase(value: unknown): SpeechPlaybackPhase {
  if (typeof value !== 'string' || !speechPlaybackPhases.includes(value as SpeechPlaybackPhase)) {
    throw new ProtocolValidationError('speech playback phase is invalid')
  }
  return value as SpeechPlaybackPhase
}

function requireErrorCode(value: unknown): ServerErrorCode {
  if (
    value !== 'invalid_message'
    && value !== 'hello_timeout'
    && value !== 'duplicate_hello'
    && value !== 'internal_error'
  ) {
    throw new ProtocolValidationError('Unsupported server error code')
  }
  return value
}

function requireModelDescriptor(value: unknown): ModelDescriptor {
  const model = requireRecord(value, 'model descriptor')
  const hasNativeUrl = model.nativeUrl !== undefined
  const hasSkinHiddenPartIds = model.skinHiddenPartIds !== undefined
  const expectedKeys = ['id', 'displayName', 'format', 'url']
  if (hasNativeUrl) expectedKeys.push('nativeUrl')
  if (hasSkinHiddenPartIds) expectedKeys.push('skinHiddenPartIds')
  requireExactKeys(
    model,
    expectedKeys,
    'model descriptor',
  )
  if (model.format !== 'pmx' && model.format !== 'live2d') {
    throw new ProtocolValidationError('model format must be pmx or live2d')
  }
  if (model.nativeUrl !== undefined && model.format !== 'live2d') {
    throw new ProtocolValidationError('nativeUrl is only supported for Live2D models')
  }
  if (model.skinHiddenPartIds !== undefined && model.format !== 'live2d') {
    throw new ProtocolValidationError('skinHiddenPartIds are only supported for Live2D models')
  }
  const skinHiddenPartIds = model.skinHiddenPartIds === undefined
    ? undefined
    : requireSkinHiddenPartIds(model.skinHiddenPartIds)
  return {
    id: requireIdentifier(model.id, 'model id'),
    displayName: requireDisplayString(model.displayName, 'model displayName', 96),
    format: model.format,
    url: requireLoopbackAssetUrl(model.url),
    ...(model.nativeUrl === undefined ? {} : { nativeUrl: requireLoopbackAssetUrl(model.nativeUrl) }),
    ...(skinHiddenPartIds === undefined ? {} : { skinHiddenPartIds }),
  }
}

function requireSkinHiddenPartIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) {
    throw new ProtocolValidationError('model skinHiddenPartIds must contain at most 512 entries')
  }
  const ids = value.map((entry, index) => {
    if (
      typeof entry !== 'string'
      || entry.length < 1
      || entry.length > 128
      || entry.trim() !== entry
      || /[\u0000-\u001F\u007F]/u.test(entry)
    ) {
      throw new ProtocolValidationError(`model skinHiddenPartIds[${index}] must be a trimmed printable identifier`)
    }
    return entry
  })
  if (new Set(ids).size !== ids.length) {
    throw new ProtocolValidationError('model skinHiddenPartIds must not contain duplicates')
  }
  return ids
}

function requireLoopbackAssetUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ProtocolValidationError('model URL must be a printable string up to 4096 characters')
  }

  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new ProtocolValidationError('model URL must be valid')
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || !/^\/assets\/[A-Za-z0-9_-]{16,128}\/.+/u.test(url.pathname)
  ) {
    throw new ProtocolValidationError('model URL must use the tokenized loopback asset endpoint')
  }
  return url.href
}

function requireMotionDescriptor(value: unknown): MotionDescriptor {
  const motion = requireRecord(value, 'motion descriptor')
  if (motion.format === 'vmd') {
    if (motion.loop !== undefined) {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url', 'loop'], 'VMD motion descriptor')
      if (typeof motion.loop !== 'boolean') throw new ProtocolValidationError('motion loop must be boolean')
    }
    else {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url'], 'VMD motion descriptor')
    }
    return {
      id: requireIdentifier(motion.id, 'motion id'),
      displayName: requireDisplayString(motion.displayName, 'motion displayName', 96),
      format: 'vmd',
      url: requireLoopbackAssetUrl(motion.url),
      ...(motion.loop !== undefined ? { loop: motion.loop } : {}),
    }
  }

  if (motion.format === 'live2d') {
    if (motion.loop !== undefined) {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url', 'group', 'index', 'loop'], 'Live2D motion descriptor')
      if (typeof motion.loop !== 'boolean') throw new ProtocolValidationError('motion loop must be boolean')
    }
    else {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url', 'group', 'index'], 'Live2D motion descriptor')
    }
    return {
      id: requireIdentifier(motion.id, 'motion id'),
      displayName: requireDisplayString(motion.displayName, 'motion displayName', 96),
      format: 'live2d',
      url: requireLoopbackAssetUrl(motion.url),
      group: requireDisplayString(motion.group, 'motion group', 96),
      index: requireInteger(motion.index, 'motion index', 0, 1024),
      ...(motion.loop !== undefined ? { loop: motion.loop } : {}),
    }
  }

  if (motion.format === 'canonical') {
    if (motion.loop !== undefined) {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url', 'loop'], 'canonical motion descriptor')
      if (typeof motion.loop !== 'boolean') throw new ProtocolValidationError('motion loop must be boolean')
    }
    else {
      requireExactKeys(motion, ['id', 'displayName', 'format', 'url'], 'canonical motion descriptor')
    }
    return {
      id: requireIdentifier(motion.id, 'motion id'),
      displayName: requireDisplayString(motion.displayName, 'motion displayName', 96),
      format: 'canonical',
      url: requireLoopbackAssetUrl(motion.url),
      ...(motion.loop !== undefined ? { loop: motion.loop } : {}),
    }
  }

  throw new ProtocolValidationError('motion format must be vmd, live2d or canonical')
}

function requireSpeechDescriptor(value: unknown): SpeechDescriptor {
  const speech = requireRecord(value, 'speech descriptor')
  requireExactKeys(speech, ['id', 'displayName', 'audioUrl', 'cuesUrl', 'mimeType', 'durationMs'], 'speech descriptor')
  if (typeof speech.mimeType !== 'string' || !speechAudioMimeTypes.includes(speech.mimeType as SpeechAudioMimeType)) {
    throw new ProtocolValidationError('speech mimeType is unsupported')
  }
  return {
    id: requireIdentifier(speech.id, 'speech id'),
    displayName: requireDisplayString(speech.displayName, 'speech displayName', 96),
    audioUrl: requireLoopbackAssetUrl(speech.audioUrl),
    cuesUrl: requireLoopbackAssetUrl(speech.cuesUrl),
    mimeType: speech.mimeType as SpeechAudioMimeType,
    durationMs: requireInteger(speech.durationMs, 'speech durationMs', 1, 600_000),
  }
}

function requireWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProtocolValidationError('weight must be a finite number between 0 and 1')
  }
  return value
}

function requireDurationMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new ProtocolValidationError('durationMs must be a non-negative safe integer up to 60000')
  }
  return value
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function requireFiniteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProtocolValidationError(`${name} must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}
