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

const MAX_LOCAL_CONFIG_BYTES = 64 * 1024

export interface RayureLocalConfig {
  model?: CompanionModelSource | undefined
  motions?: readonly CompanionMotionSource[] | undefined
  motionSemantic?: RayureMotionSemanticConfig | undefined
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

  return {
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(resolvedMotions ? { motions: resolvedMotions } : {}),
    ...(motionSemantic ? { motionSemantic } : {}),
  }
}

function resolveMotionSemanticConfig(value: unknown): RayureMotionSemanticConfig {
  const root = requireRecord(value, 'motionSemantic config')
  const allowedKeys = []
  if (root.cachePath !== undefined) allowedKeys.push('cachePath')
  if (root.textEncoder !== undefined) allowedKeys.push('textEncoder')
  if (root.ardy !== undefined) allowedKeys.push('ardy')
  if (root.startupGenerate !== undefined) allowedKeys.push('startupGenerate')
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

  return {
    ...(cachePath === undefined ? {} : { cachePath }),
    ...(textEncoder === undefined ? {} : { textEncoder }),
    ...(ardy === undefined ? {} : { ardy }),
    ...(startupGenerate === undefined ? {} : { startupGenerate }),
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
