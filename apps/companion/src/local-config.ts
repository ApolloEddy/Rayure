import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

import {
  DEFAULT_TEXT_ENCODER_TIMEOUT_MS,
  validateTextEncoderEndpoint,
  validateTextEncoderTimeout,
} from './text-encoder-client.ts'
import {
  DEFAULT_ARDY_PROCESS_TIMEOUT_MS,
  validateArdyProcessArgs,
  validateArdyProcessCommand,
  validateArdyProcessCwd,
  validateArdyProcessTimeout,
} from './ardy-process-client.ts'
import type { CompanionModelSource, CompanionMotionSource } from './model-source.ts'
import {
  validateVisionProcessArgs,
  validateVisionProcessCommand,
  validateVisionProcessCwd,
} from './vision-process-client.ts'
import {
  validateSpeechProcessArgs,
  validateSpeechProcessCommand,
  validateSpeechProcessCwd,
  validateSpeechProcessTimeout,
} from './speech/process-client.ts'
import { validateAgentEndpoint, validateAgentTimeout } from './speech/agent-client.ts'
import {
  validateLiveTalkerBaseUrl,
  validateLiveTalkerLanguage,
  validateLiveTalkerMotionByKeyword,
  validateLiveTalkerTimeout,
} from './speech/livetalker-client.ts'
import {
  validateTtsProcessArgs,
  validateTtsProcessCommand,
  validateTtsProcessCwd,
  validateTtsProcessTimeout,
} from './speech/tts-process-client.ts'

const MAX_LOCAL_CONFIG_BYTES = 64 * 1024

export interface RayureLocalConfig {
  model?: CompanionModelSource | undefined
  motions?: readonly CompanionMotionSource[] | undefined
  motionSemantic?: RayureMotionSemanticConfig | undefined
  vision?: RayureVisionConfig | undefined
  speech?: RayureSpeechConfig | undefined
}

export interface RayureSpeechConfig {
  enabled: boolean
  liveTalker?: {
    baseUrl: string
    timeoutMs?: number | undefined
    language?: string | undefined
    motionByKeyword?: Readonly<Record<string, string>> | undefined
  } | undefined
  agent?: {
    endpoint: string
    timeoutMs?: number | undefined
  } | undefined
  tts?: {
    command: string
    args: readonly string[]
    cwd?: string | undefined
    requestTimeoutMs?: number | undefined
  } | undefined
  asr?: {
    command: string
    args: readonly string[]
    cwd?: string | undefined
    startupTimeoutMs?: number | undefined
  } | undefined
}

export const visionActionTypes = [
  'presence.enter',
  'presence.leave',
  'gesture.wave',
  'gesture.hand_raise',
  'head.left',
  'head.right',
  'head.center',
] as const
export type VisionActionType = typeof visionActionTypes[number]

export interface RayureVisionConfig {
  enabled: boolean
  command: string
  args: readonly string[]
  cwd?: string | undefined
  modelPath?: string | undefined
  cameraIndex: number
  fps: number
  width: number
  height: number
  actions?: Partial<Record<VisionActionType, string>> | undefined
}

export interface RayureMotionSemanticConfig {
  cachePath?: string | undefined
  textEncoder?: {
    endpoint: string
    timeoutMs: number
  } | undefined
  ardy?: {
    command: string
    args: readonly string[]
    cwd?: string | undefined
    requestTimeoutMs: number
  } | undefined
  startupGenerate?: readonly RayureMotionGeneratePreset[] | undefined
  scene?: RayureMotionSceneConfig | undefined
}

export interface RayureMotionSceneConfig {
  entities?: readonly RayureMotionSceneEntity[] | undefined
  transform?: {
    origin?: readonly [number, number, number] | undefined
    scale?: number | undefined
  } | undefined
}

export interface RayureMotionSceneEntity {
  id: string
  position: readonly [number, number, number]
  headingRadians?: number | undefined
}

export interface RayureMotionGeneratePreset {
  id: string
  prompt: string
  numFrames?: number | undefined
  numDenoisingSteps?: number | undefined
  cfgWeight?: number | undefined
}

export interface LoadLocalConfigOptions {
  optional?: boolean | undefined
}

export async function loadLocalConfig(
  configPath: string,
  options: LoadLocalConfigOptions = {},
): Promise<RayureLocalConfig> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  }
  catch (cause) {
    if (options.optional === true && isNodeError(cause, 'ENOENT')) return {}
    throw new Error(`Rayure local config could not be read: ${toErrorMessage(cause)}`)
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_CONFIG_BYTES) {
    throw new Error('Rayure local config exceeds 64 KiB')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Rayure local config must contain valid JSON')
  }

  const root = requireRecord(parsed, 'Rayure local config')
  const allowedKeys = []
  if (root.model !== undefined) allowedKeys.push('model')
  if (root.motions !== undefined) allowedKeys.push('motions')
  if (root.motionSemantic !== undefined) allowedKeys.push('motionSemantic')
  if (root.vision !== undefined) allowedKeys.push('vision')
  if (root.speech !== undefined) allowedKeys.push('speech')
  requireExactKeys(root, allowedKeys, 'Rayure local config')

  let resolvedModel: CompanionModelSource | undefined
  if (root.model !== undefined) {
    const model = requireRecord(root.model, 'model')
    requireExactKeys(model, ['id', 'displayName', 'format', 'path'], 'model')
    const id = requireIdentifier(model.id)
    const displayName = requireDisplayName(model.displayName)
    if (model.format !== 'pmx' && model.format !== 'live2d') {
      throw new Error('Configured model format must be pmx or live2d')
    }
    const format = model.format
    const configuredPath = format === 'pmx'
      ? requireAbsolutePmxPath(model.path)
      : requireAbsoluteLive2dPath(model.path)

    try {
      const entryFilePath = await realpath(configuredPath)
      const metadata = await stat(entryFilePath)
      if (!metadata.isFile()) throw new Error('path is not a regular file')
      resolvedModel = { id, displayName, format, entryFilePath }
    }
    catch (cause) {
      const label = format === 'live2d' ? 'Live2D model3' : 'PMX'
      throw new Error(`Configured ${label} model must exist as a regular file: ${toErrorMessage(cause)}`)
    }
  }

  let resolvedMotions: CompanionMotionSource[] | undefined
  if (root.motions !== undefined) {
    if (!Array.isArray(root.motions)) {
      throw new Error('Configured motions must be an array')
    }
    resolvedMotions = []
    for (const item of root.motions) {
      const motion = requireRecord(item, 'motion item')
      const keys = ['id', 'displayName', 'format', 'path']
      if (motion.loop !== undefined) keys.push('loop')
      requireExactKeys(motion, keys, 'motion item')

      const id = requireIdentifier(motion.id)
      const displayName = requireDisplayName(motion.displayName)
      if (motion.format !== 'vmd') throw new Error('Configured motion format must be vmd')
      const configuredPath = requireAbsoluteVmdPath(motion.path)

      try {
        const entryFilePath = await realpath(configuredPath)
        const metadata = await stat(entryFilePath)
        if (!metadata.isFile()) throw new Error('path is not a regular file')
        resolvedMotions.push({
          id,
          displayName,
          format: 'vmd',
          entryFilePath,
          ...(motion.loop !== undefined ? { loop: Boolean(motion.loop) } : {}),
        })
      }
      catch (cause) {
        throw new Error(`Configured VMD motion must exist as a regular file: ${toErrorMessage(cause)}`)
      }
    }
  }

  const motionSemantic = root.motionSemantic === undefined
    ? undefined
    : resolveMotionSemanticConfig(root.motionSemantic)
  const vision = root.vision === undefined ? undefined : resolveVisionConfig(root.vision)
  const speech = root.speech === undefined ? undefined : resolveSpeechConfig(root.speech)

  return {
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(resolvedMotions ? { motions: resolvedMotions } : {}),
    ...(motionSemantic ? { motionSemantic } : {}),
    ...(vision ? { vision } : {}),
    ...(speech ? { speech } : {}),
  }
}

function resolveSpeechConfig(value: unknown): RayureSpeechConfig {
  const root = requireRecord(value, 'speech config')
  const allowedKeys = ['enabled']
  if (root.liveTalker !== undefined) allowedKeys.push('liveTalker')
  if (root.agent !== undefined) allowedKeys.push('agent')
  if (root.tts !== undefined) allowedKeys.push('tts')
  if (root.asr !== undefined) allowedKeys.push('asr')
  requireExactKeys(root, allowedKeys, 'speech config')
  if (typeof root.enabled !== 'boolean') throw new Error('speech enabled must be boolean')
  if (root.liveTalker !== undefined && (root.agent !== undefined || root.tts !== undefined)) {
    throw new Error('speech liveTalker cannot be combined with agent or tts')
  }
  const liveTalker = root.liveTalker === undefined ? undefined : resolveLiveTalkerConfig(root.liveTalker)
  const agent = root.agent === undefined ? undefined : resolveSpeechAgentConfig(root.agent)
  const tts = root.tts === undefined ? undefined : resolveSpeechTtsConfig(root.tts)
  if (root.asr === undefined) return {
    enabled: root.enabled,
    ...(liveTalker === undefined ? {} : { liveTalker }),
    ...(agent === undefined ? {} : { agent }),
    ...(tts === undefined ? {} : { tts }),
  }
  const asrRoot = requireRecord(root.asr, 'speech asr config')
  const asrKeys = ['command', 'args']
  if (asrRoot.cwd !== undefined) asrKeys.push('cwd')
  if (asrRoot.startupTimeoutMs !== undefined) asrKeys.push('startupTimeoutMs')
  requireExactKeys(asrRoot, asrKeys, 'speech asr config')
  if (!Array.isArray(asrRoot.args)) throw new Error('speech asr args must be an array')
  return {
    enabled: root.enabled,
    ...(liveTalker === undefined ? {} : { liveTalker }),
    ...(agent === undefined ? {} : { agent }),
    ...(tts === undefined ? {} : { tts }),
    asr: {
      command: validateSpeechProcessCommand(asrRoot.command),
      args: validateSpeechProcessArgs(asrRoot.args),
      ...(asrRoot.cwd === undefined ? {} : { cwd: validateSpeechProcessCwd(asrRoot.cwd) }),
      ...(asrRoot.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: validateSpeechProcessTimeout(asrRoot.startupTimeoutMs) }),
    },
  }
}

function resolveLiveTalkerConfig(value: unknown): NonNullable<RayureSpeechConfig['liveTalker']> {
  const root = requireRecord(value, 'speech liveTalker config')
  const allowedKeys = ['baseUrl']
  if (root.timeoutMs !== undefined) allowedKeys.push('timeoutMs')
  if (root.language !== undefined) allowedKeys.push('language')
  if (root.motionByKeyword !== undefined) allowedKeys.push('motionByKeyword')
  requireExactKeys(root, allowedKeys, 'speech liveTalker config')
  return {
    baseUrl: validateLiveTalkerBaseUrl(root.baseUrl),
    ...(root.timeoutMs === undefined ? {} : { timeoutMs: validateLiveTalkerTimeout(root.timeoutMs) }),
    ...(root.language === undefined ? {} : { language: validateLiveTalkerLanguage(root.language) }),
    ...(root.motionByKeyword === undefined ? {} : { motionByKeyword: validateLiveTalkerMotionByKeyword(root.motionByKeyword) }),
  }
}

function resolveSpeechTtsConfig(value: unknown): NonNullable<RayureSpeechConfig['tts']> {
  const root = requireRecord(value, 'speech tts config')
  const allowedKeys = ['command', 'args']
  if (root.cwd !== undefined) allowedKeys.push('cwd')
  if (root.requestTimeoutMs !== undefined) allowedKeys.push('requestTimeoutMs')
  requireExactKeys(root, allowedKeys, 'speech tts config')
  if (!Array.isArray(root.args)) throw new Error('speech tts args must be an array')
  return {
    command: validateTtsProcessCommand(root.command),
    args: validateTtsProcessArgs(root.args),
    ...(root.cwd === undefined ? {} : { cwd: validateTtsProcessCwd(root.cwd) }),
    ...(root.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: validateTtsProcessTimeout(root.requestTimeoutMs) }),
  }
}

function resolveSpeechAgentConfig(value: unknown): NonNullable<RayureSpeechConfig['agent']> {
  const root = requireRecord(value, 'speech agent config')
  const allowedKeys = ['endpoint']
  if (root.timeoutMs !== undefined) allowedKeys.push('timeoutMs')
  requireExactKeys(root, allowedKeys, 'speech agent config')
  return {
    endpoint: validateAgentEndpoint(root.endpoint),
    ...(root.timeoutMs === undefined ? {} : { timeoutMs: validateAgentTimeout(root.timeoutMs) }),
  }
}

function resolveVisionConfig(value: unknown): RayureVisionConfig {
  const root = requireRecord(value, 'vision config')
  const allowedKeys = ['enabled', 'command', 'args']
  if (root.cameraIndex !== undefined) allowedKeys.push('cameraIndex')
  if (root.fps !== undefined) allowedKeys.push('fps')
  if (root.width !== undefined) allowedKeys.push('width')
  if (root.height !== undefined) allowedKeys.push('height')
  if (root.cwd !== undefined) allowedKeys.push('cwd')
  if (root.modelPath !== undefined) allowedKeys.push('modelPath')
  if (root.actions !== undefined) allowedKeys.push('actions')
  requireExactKeys(root, allowedKeys, 'vision config')
  if (typeof root.enabled !== 'boolean') throw new Error('vision enabled must be boolean')
  if (!Array.isArray(root.args)) throw new Error('vision args must be an array')
  const args = validateVisionProcessArgs(root.args)
  const reservedArgs = new Set(['--model', '--camera-index', '--fps', '--width', '--height'])
  if (args.some(arg => reservedArgs.has(arg))) throw new Error('vision args must not contain reserved runtime options')
  const modelPath = root.modelPath === undefined ? undefined : requireVisionModelPath(root.modelPath)
  if (root.enabled && modelPath === undefined && !args.includes('--simulate')) {
    throw new Error('enabled vision config requires modelPath unless args contains --simulate')
  }
  const actions = root.actions === undefined ? undefined : resolveVisionActions(root.actions)
  return {
    enabled: root.enabled,
    command: validateVisionProcessCommand(root.command),
    args,
    cameraIndex: root.cameraIndex === undefined ? 0 : requireGenerateInteger(root.cameraIndex, 'vision cameraIndex', 0, 32),
    fps: root.fps === undefined ? 8 : requireGenerateInteger(root.fps, 'vision fps', 1, 30),
    width: root.width === undefined ? 640 : requireGenerateInteger(root.width, 'vision width', 160, 1920),
    height: root.height === undefined ? 360 : requireGenerateInteger(root.height, 'vision height', 120, 1080),
    ...(root.cwd === undefined ? {} : { cwd: validateVisionProcessCwd(root.cwd) }),
    ...(modelPath === undefined ? {} : { modelPath }),
    ...(actions === undefined ? {} : { actions }),
  }
}

function resolveVisionActions(value: unknown): Partial<Record<VisionActionType, string>> {
  const root = requireRecord(value, 'vision actions')
  const allowedKeys = Object.keys(root)
  if (allowedKeys.some(key => !visionActionTypes.includes(key as VisionActionType))) {
    throw new Error('vision actions contains an unsupported event type')
  }
  const actions: Partial<Record<VisionActionType, string>> = {}
  for (const key of allowedKeys as VisionActionType[]) actions[key] = requireIdentifier(root[key])
  return actions
}

function requireVisionModelPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.trim() !== value || value.includes('\u0000')) {
    throw new Error('vision modelPath must be an absolute path')
  }
  return value
}

function resolveMotionSemanticConfig(value: unknown): RayureMotionSemanticConfig {
  const root = requireRecord(value, 'motionSemantic config')
  const allowedKeys = []
  if (root.cachePath !== undefined) allowedKeys.push('cachePath')
  if (root.textEncoder !== undefined) allowedKeys.push('textEncoder')
  if (root.ardy !== undefined) allowedKeys.push('ardy')
  if (root.startupGenerate !== undefined) allowedKeys.push('startupGenerate')
  if (root.scene !== undefined) allowedKeys.push('scene')
  requireExactKeys(root, allowedKeys, 'motionSemantic config')
  if (allowedKeys.length === 0) throw new Error('motionSemantic config must define cachePath or textEncoder')

  const cachePath = root.cachePath === undefined
    ? undefined
    : requireAbsoluteFeatureCachePath(root.cachePath)
  let textEncoder: RayureMotionSemanticConfig['textEncoder']
  if (root.textEncoder !== undefined) {
    const encoder = requireRecord(root.textEncoder, 'motionSemantic textEncoder')
    const encoderKeys = ['endpoint']
    if (encoder.timeoutMs !== undefined) encoderKeys.push('timeoutMs')
    requireExactKeys(encoder, encoderKeys, 'motionSemantic textEncoder')
    textEncoder = {
      endpoint: validateTextEncoderEndpoint(encoder.endpoint),
      timeoutMs: validateTextEncoderTimeout(encoder.timeoutMs ?? DEFAULT_TEXT_ENCODER_TIMEOUT_MS),
    }
  }

  let ardy: RayureMotionSemanticConfig['ardy']
  if (root.ardy !== undefined) ardy = resolveArdyConfig(root.ardy)

  let startupGenerate: RayureMotionSemanticConfig['startupGenerate']
  if (root.startupGenerate !== undefined) {
    if (ardy === undefined) throw new Error('motionSemantic startupGenerate requires a configured ardy backend')
    startupGenerate = resolveStartupGenerate(root.startupGenerate)
  }

  const scene = root.scene === undefined ? undefined : resolveSceneConfig(root.scene)

  return {
    ...(cachePath === undefined ? {} : { cachePath }),
    ...(textEncoder === undefined ? {} : { textEncoder }),
    ...(ardy === undefined ? {} : { ardy }),
    ...(startupGenerate === undefined ? {} : { startupGenerate }),
    ...(scene === undefined ? {} : { scene }),
  }
}

function resolveSceneConfig(value: unknown): RayureMotionSceneConfig {
  const root = requireRecord(value, 'motionSemantic scene')
  const allowedKeys = []
  if (root.entities !== undefined) allowedKeys.push('entities')
  if (root.transform !== undefined) allowedKeys.push('transform')
  requireExactKeys(root, allowedKeys, 'motionSemantic scene')
  if (allowedKeys.length === 0) throw new Error('motionSemantic scene must define entities or transform')

  let entities: RayureMotionSceneEntity[] | undefined
  if (root.entities !== undefined) {
    if (!Array.isArray(root.entities) || root.entities.length > 128) {
      throw new Error('motionSemantic scene entities must contain up to 128 items')
    }
    const ids = new Set<string>()
    entities = root.entities.map((item, index) => {
      const entity = requireRecord(item, `motionSemantic scene entities[${index}]`)
      const keys = ['id', 'position']
      if (entity.headingRadians !== undefined) keys.push('headingRadians')
      requireExactKeys(entity, keys, `motionSemantic scene entities[${index}]`)
      const id = requireIdentifier(entity.id)
      if (ids.has(id)) throw new Error(`motionSemantic scene entity id is duplicated: ${id}`)
      ids.add(id)
      const headingRadians = entity.headingRadians === undefined
        ? undefined
        : requireGenerateNumber(entity.headingRadians, `scene entity ${id} headingRadians`, -Math.PI * 8, Math.PI * 8)
      return {
        id,
        position: requireVector3(entity.position, `scene entity ${id} position`),
        ...(headingRadians === undefined ? {} : { headingRadians }),
      }
    })
  }

  let transform: RayureMotionSceneConfig['transform']
  if (root.transform !== undefined) {
    const source = requireRecord(root.transform, 'motionSemantic scene transform')
    const keys = []
    if (source.origin !== undefined) keys.push('origin')
    if (source.scale !== undefined) keys.push('scale')
    requireExactKeys(source, keys, 'motionSemantic scene transform')
    if (keys.length === 0) throw new Error('motionSemantic scene transform must define origin or scale')
    const scale = source.scale === undefined
      ? undefined
      : requireGenerateNumber(source.scale, 'scene transform scale', Number.MIN_VALUE, 1_000)
    transform = {
      ...(source.origin === undefined ? {} : { origin: requireVector3(source.origin, 'scene transform origin') }),
      ...(scale === undefined ? {} : { scale }),
    }
  }

  return {
    ...(entities === undefined ? {} : { entities }),
    ...(transform === undefined ? {} : { transform }),
  }
}

function resolveStartupGenerate(value: unknown): readonly RayureMotionGeneratePreset[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error('motionSemantic startupGenerate must be a non-empty array up to 32 presets')
  }
  return value.map((item, index) => {
    const preset = requireRecord(item, `motionSemantic startupGenerate[${index}]`)
    const presetKeys = ['id', 'prompt']
    if (preset.numFrames !== undefined) presetKeys.push('numFrames')
    if (preset.numDenoisingSteps !== undefined) presetKeys.push('numDenoisingSteps')
    if (preset.cfgWeight !== undefined) presetKeys.push('cfgWeight')
    requireExactKeys(preset, presetKeys, `motionSemantic startupGenerate[${index}]`)
    const id = requireIdentifier(preset.id)
    const prompt = requirePrompt(preset.prompt)
    return {
      id,
      prompt,
      ...(preset.numFrames === undefined ? {} : { numFrames: requireGenerateInteger(preset.numFrames, `startupGenerate[${index}] numFrames`, 1, 600) }),
      ...(preset.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: requireGenerateInteger(preset.numDenoisingSteps, `startupGenerate[${index}] numDenoisingSteps`, 1, 20) }),
      ...(preset.cfgWeight === undefined ? {} : { cfgWeight: requireGenerateNumber(preset.cfgWeight, `startupGenerate[${index}] cfgWeight`, 0, 20) }),
    }
  })
}

function resolveArdyConfig(value: unknown): NonNullable<RayureMotionSemanticConfig['ardy']> {
  const root = requireRecord(value, 'motionSemantic ardy')
  const allowedKeys = ['command', 'args']
  if (root.cwd !== undefined) allowedKeys.push('cwd')
  if (root.requestTimeoutMs !== undefined) allowedKeys.push('requestTimeoutMs')
  requireExactKeys(root, allowedKeys, 'motionSemantic ardy')
  if (!Array.isArray(root.args)) throw new Error('motionSemantic ardy args must be an array')
  const result: NonNullable<RayureMotionSemanticConfig['ardy']> = {
    command: validateArdyProcessCommand(root.command),
    args: validateArdyProcessArgs(root.args),
    requestTimeoutMs: validateArdyProcessTimeout(root.requestTimeoutMs ?? DEFAULT_ARDY_PROCESS_TIMEOUT_MS),
  }
  if (root.cwd !== undefined) result.cwd = validateArdyProcessCwd(root.cwd)
  return result
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${name} contains missing or unknown fields`)
  }
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) {
    throw new Error('Configured model id must be a 1-64 character identifier')
  }
  return value
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 96
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error('Configured model displayName must be a trimmed printable string up to 96 characters')
  }
  return value
}

function requirePrompt(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error('Configured startupGenerate prompt must be a trimmed printable string up to 512 characters')
  }
  return value
}

function requireVector3(value: unknown, name: string): readonly [number, number, number] {
  if (
    !Array.isArray(value)
    || value.length !== 3
    || value.some(component => typeof component !== 'number' || !Number.isFinite(component))
  ) {
    throw new Error(`Configured ${name} must be a finite 3D vector`)
  }
  return [value[0], value[1], value[2]]
}

function requireAbsolutePmxPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new Error('Configured model path must be an absolute PMX path')
  }
  if (extname(value).toLowerCase() !== '.pmx') throw new Error('Configured model path must reference a PMX file')
  return value
}

function requireAbsoluteLive2dPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new Error('Configured model path must be an absolute Live2D model3.json path')
  }
  if (!value.toLowerCase().endsWith('.model3.json')) {
    throw new Error('Configured model path must reference a Live2D model3.json file')
  }
  return value
}

function requireAbsoluteVmdPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new Error('Configured motion path must be an absolute VMD path')
  }
  if (extname(value).toLowerCase() !== '.vmd') throw new Error('Configured motion path must reference a VMD file')
  return value
}

function requireAbsoluteFeatureCachePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new Error('Configured motion semantic cachePath must be an absolute path')
  }
  if (extname(value).toLowerCase() !== '.json') {
    throw new Error('Configured motion semantic cachePath must reference a JSON cache file')
  }
  return value
}

function requireGenerateInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Configured ${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function requireGenerateNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Configured ${name} must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
