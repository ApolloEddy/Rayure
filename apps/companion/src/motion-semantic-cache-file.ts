import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import {
  ARDY_TEXT_FEATURE_DIMENSION,
  MOTION_SEMANTIC_FEATURE_MAX_TOKENS,
  MotionSemanticFeatureValidationError,
  validateMotionSemanticFeature,
} from '@rayure/protocol'
import type { MotionSemanticFeature, MotionSemanticFeatureDtype } from '@rayure/protocol'

export const MOTION_SEMANTIC_CACHE_FILE_SCHEMA = 'rayure.motion-semantic-cache.v1' as const
export const MAX_MOTION_SEMANTIC_CACHE_FILE_BYTES = 512 * 1024 * 1024
export const MAX_MOTION_SEMANTIC_CACHE_ENTRIES = 100_000

export interface MotionSemanticFeatureCacheFileEntry {
  cacheKey: string
  canonicalPrompt: string
  encoderId: string
  encoderVersion: string
  dtype: MotionSemanticFeatureDtype
  tokenCount: number
  featureDimension: typeof ARDY_TEXT_FEATURE_DIMENSION
  valuesBase64: string
  textPadMaskBase64: string
  createdAtMs: number
}

export interface MotionSemanticFeatureCacheFile {
  schema: typeof MOTION_SEMANTIC_CACHE_FILE_SCHEMA
  entries: readonly MotionSemanticFeatureCacheFileEntry[]
}

export async function loadMotionSemanticFeatureCacheFile(
  filePath: string,
): Promise<readonly MotionSemanticFeature[]> {
  const raw = await readFile(filePath)
  if (raw.byteLength > MAX_MOTION_SEMANTIC_CACHE_FILE_BYTES) {
    throw new Error('Motion semantic feature cache exceeds 512 MiB')
  }
  return parseMotionSemanticFeatureCache(raw.toString('utf8'))
}

export function loadMotionSemanticFeatureCacheFileSync(filePath: string): readonly MotionSemanticFeature[] {
  const raw = readFileSync(filePath)
  if (raw.byteLength > MAX_MOTION_SEMANTIC_CACHE_FILE_BYTES) {
    throw new Error('Motion semantic feature cache exceeds 512 MiB')
  }
  return parseMotionSemanticFeatureCache(raw.toString('utf8'))
}

export function parseMotionSemanticFeatureCache(raw: string): readonly MotionSemanticFeature[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Motion semantic feature cache must contain valid JSON')
  }

  const root = requireRecord(parsed, 'motion semantic feature cache')
  requireExactKeys(root, ['schema', 'entries'], 'motion semantic feature cache')
  if (root.schema !== MOTION_SEMANTIC_CACHE_FILE_SCHEMA) {
    throw new Error('Unsupported motion semantic feature cache schema')
  }
  const rawEntries = requireArray(root.entries, 'motion semantic feature cache entries')
  if (rawEntries.length > MAX_MOTION_SEMANTIC_CACHE_ENTRIES) {
    throw new Error('Motion semantic feature cache contains too many entries')
  }

  const seenKeys = new Set<string>()
  const features: MotionSemanticFeature[] = []
  for (const [index, rawEntry] of rawEntries.entries()) {
    const entry = requireRecord(rawEntry, `motion semantic feature cache entry ${index}`)
    requireExactKeys(
      entry,
      [
        'cacheKey',
        'canonicalPrompt',
        'encoderId',
        'encoderVersion',
        'dtype',
        'tokenCount',
        'featureDimension',
        'valuesBase64',
        'textPadMaskBase64',
        'createdAtMs',
      ],
      `motion semantic feature cache entry ${index}`,
    )

    const cacheKey = requireCacheKey(entry.cacheKey, index)
    if (seenKeys.has(cacheKey)) throw new Error(`Duplicate motion feature cacheKey: ${cacheKey}`)
    seenKeys.add(cacheKey)
    const tokenCount = requireInteger(entry.tokenCount, `entry ${index}.tokenCount`, 1, MOTION_SEMANTIC_FEATURE_MAX_TOKENS)
    if (entry.featureDimension !== ARDY_TEXT_FEATURE_DIMENSION) {
      throw new Error(`entry ${index}.featureDimension must be ${ARDY_TEXT_FEATURE_DIMENSION}`)
    }
    if (entry.dtype !== 'float16' && entry.dtype !== 'float32') {
      throw new Error(`entry ${index}.dtype must be float16 or float32`)
    }
    const values = decodeValues(entry.valuesBase64, entry.dtype, tokenCount, index)
    const textPadMask = decodeMask(entry.textPadMaskBase64, tokenCount, index)
    const canonicalPrompt = requireDisplayString(entry.canonicalPrompt, `entry ${index}.canonicalPrompt`, 512)
    const encoderId = requireDisplayString(entry.encoderId, `entry ${index}.encoderId`, 128)
    const encoderVersion = requireDisplayString(entry.encoderVersion, `entry ${index}.encoderVersion`, 128)
    const createdAtMs = requireInteger(entry.createdAtMs, `entry ${index}.createdAtMs`, 0, Number.MAX_SAFE_INTEGER)
    const feature = {
      schema: 'rayure.motion-semantic-feature.v1',
      cacheKey,
      canonicalPrompt,
      encoderId,
      encoderVersion,
      dtype: entry.dtype,
      tokenCount,
      featureDimension: ARDY_TEXT_FEATURE_DIMENSION,
      values,
      textPadMask,
      createdAtMs,
    } satisfies MotionSemanticFeature
    try {
      validateMotionSemanticFeature(feature)
    }
    catch (cause) {
      if (cause instanceof MotionSemanticFeatureValidationError) throw cause
      throw new Error(`Invalid motion semantic feature cache entry ${index}`)
    }
    features.push(feature)
  }
  return features
}

export function serializeMotionSemanticFeatureCache(
  features: readonly MotionSemanticFeature[],
): string {
  if (features.length > MAX_MOTION_SEMANTIC_CACHE_ENTRIES) {
    throw new Error('Motion semantic feature cache contains too many entries')
  }
  const seenKeys = new Set<string>()
  const entries: MotionSemanticFeatureCacheFileEntry[] = []
  for (const feature of [...features].sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))) {
    validateMotionSemanticFeature(feature)
    if (seenKeys.has(feature.cacheKey)) throw new Error(`Duplicate motion feature cacheKey: ${feature.cacheKey}`)
    seenKeys.add(feature.cacheKey)
    entries.push({
      cacheKey: feature.cacheKey,
      canonicalPrompt: feature.canonicalPrompt,
      encoderId: feature.encoderId,
      encoderVersion: feature.encoderVersion,
      dtype: feature.dtype,
      tokenCount: feature.tokenCount,
      featureDimension: ARDY_TEXT_FEATURE_DIMENSION,
      valuesBase64: encodeValues(feature.values, feature.dtype),
      textPadMaskBase64: encodeMask(feature.textPadMask),
      createdAtMs: feature.createdAtMs,
    })
  }
  const file: MotionSemanticFeatureCacheFile = {
    schema: MOTION_SEMANTIC_CACHE_FILE_SCHEMA,
    entries,
  }
  return JSON.stringify(file)
}

export async function writeMotionSemanticFeatureCacheFile(
  filePath: string,
  features: readonly MotionSemanticFeature[],
): Promise<void> {
  const raw = serializeMotionSemanticFeatureCache(features)
  const byteLength = Buffer.byteLength(raw, 'utf8')
  if (byteLength > MAX_MOTION_SEMANTIC_CACHE_FILE_BYTES) {
    throw new Error('Motion semantic feature cache exceeds 512 MiB')
  }

  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, raw, 'utf8')
    await rename(temporaryPath, filePath)
  }
  finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function encodeValues(values: readonly number[], dtype: MotionSemanticFeatureDtype): string {
  const bytesPerValue = dtype === 'float16' ? 2 : 4
  const buffer = Buffer.allocUnsafe(values.length * bytesPerValue)
  for (const [index, value] of values.entries()) {
    if (dtype === 'float16') buffer.writeUInt16LE(float32ToFloat16(value), index * 2)
    else buffer.writeFloatLE(value, index * 4)
  }
  return buffer.toString('base64')
}

function decodeValues(
  value: unknown,
  dtype: MotionSemanticFeatureDtype,
  tokenCount: number,
  index: number,
): number[] {
  const encoded = requireBase64(value, `entry ${index}.valuesBase64`)
  const bytesPerValue = dtype === 'float16' ? 2 : 4
  const expectedValueCount = tokenCount * ARDY_TEXT_FEATURE_DIMENSION
  const expectedByteLength = expectedValueCount * bytesPerValue
  if (encoded.byteLength !== expectedByteLength) {
    throw new Error(`entry ${index}.valuesBase64 has the wrong byte length`)
  }
  const values = new Array<number>(expectedValueCount)
  for (let valueIndex = 0; valueIndex < expectedValueCount; valueIndex += 1) {
    values[valueIndex] = dtype === 'float16'
      ? float16ToFloat32(encoded.readUInt16LE(valueIndex * 2))
      : encoded.readFloatLE(valueIndex * 4)
  }
  return values
}

function encodeMask(mask: readonly boolean[]): string {
  const buffer = Buffer.alloc(Math.ceil(mask.length / 8))
  for (const [index, value] of mask.entries()) {
    if (value) buffer[index >> 3] = buffer[index >> 3]! | (1 << (index & 7))
  }
  return buffer.toString('base64')
}

function decodeMask(value: unknown, tokenCount: number, index: number): boolean[] {
  const encoded = requireBase64(value, `entry ${index}.textPadMaskBase64`)
  const expectedByteLength = Math.ceil(tokenCount / 8)
  if (encoded.byteLength !== expectedByteLength) {
    throw new Error(`entry ${index}.textPadMaskBase64 has the wrong byte length`)
  }
  const unusedBits = expectedByteLength * 8 - tokenCount
  if (unusedBits > 0 && (encoded[expectedByteLength - 1]! & (0xff << (8 - unusedBits))) !== 0) {
    throw new Error(`entry ${index}.textPadMaskBase64 contains non-zero unused bits`)
  }
  return Array.from({ length: tokenCount }, (_, maskIndex) => {
    return (encoded[maskIndex >> 3]! & (1 << (maskIndex & 7))) !== 0
  })
}

function requireBase64(value: unknown, name: string): Buffer {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error(`${name} must be canonical base64`)
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) throw new Error(`${name} must be canonical base64`)
  return buffer
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

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireCacheKey(value: unknown, index: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error(`entry ${index}.cacheKey is invalid`)
  }
  return value
}

function requireDisplayString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${name} must be a trimmed printable string up to ${maximumLength} characters`)
  }
  return value
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function float32ToFloat16(value: number): number {
  const floatView = new Float32Array(1)
  const intView = new Uint32Array(floatView.buffer)
  floatView[0] = value
  const bits = intView[0]!
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff

  if (exponent === 0xff) return sign | (mantissa === 0 ? 0x7c00 : 0x7e00)
  const halfExponent = exponent - 127 + 15
  if (halfExponent >= 0x1f) return sign | 0x7c00
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign
    const normalizedMantissa = mantissa | 0x800000
    const shift = 14 - halfExponent
    return sign | (normalizedMantissa >>> shift)
  }
  return sign | (halfExponent << 10) | (mantissa >>> 13)
}

function float16ToFloat32(value: number): number {
  const sign = (value & 0x8000) << 16
  let exponent = (value >>> 10) & 0x1f
  let mantissa = value & 0x3ff
  let bits: number

  if (exponent === 0) {
    if (mantissa === 0) bits = sign
    else {
      while ((mantissa & 0x400) === 0) {
        mantissa <<= 1
        exponent -= 1
      }
      exponent += 1
      mantissa &= ~0x400
      bits = sign | ((exponent + (127 - 15)) << 23) | (mantissa << 13)
    }
  }
  else if (exponent === 0x1f) bits = sign | 0x7f800000 | (mantissa << 13)
  else bits = sign | ((exponent + (127 - 15)) << 23) | (mantissa << 13)

  const intView = new Uint32Array(1)
  const floatView = new Float32Array(intView.buffer)
  intView[0] = bits >>> 0
  return floatView[0]!
}
