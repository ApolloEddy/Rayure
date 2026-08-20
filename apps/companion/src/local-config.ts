import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

import type { CompanionModelSource, CompanionMotionSource } from './model-source.ts'

const MAX_LOCAL_CONFIG_BYTES = 64 * 1024

export interface RayureLocalConfig {
  model?: CompanionModelSource | undefined
  motions?: readonly CompanionMotionSource[] | undefined
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
  requireExactKeys(root, allowedKeys, 'Rayure local config')

  let resolvedModel: CompanionModelSource | undefined
  if (root.model !== undefined) {
    const model = requireRecord(root.model, 'model')
    requireExactKeys(model, ['id', 'displayName', 'format', 'path'], 'model')
    const id = requireIdentifier(model.id)
    const displayName = requireDisplayName(model.displayName)
    if (model.format !== 'pmx') throw new Error('Configured model format must be pmx')
    const configuredPath = requireAbsolutePmxPath(model.path)

    try {
      const entryFilePath = await realpath(configuredPath)
      const metadata = await stat(entryFilePath)
      if (!metadata.isFile()) throw new Error('path is not a regular file')
      resolvedModel = { id, displayName, format: 'pmx', entryFilePath }
    }
    catch (cause) {
      throw new Error(`Configured PMX model must exist as a regular file: ${toErrorMessage(cause)}`)
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

  return {
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(resolvedMotions ? { motions: resolvedMotions } : {}),
  }
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

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
