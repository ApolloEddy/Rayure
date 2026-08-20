import {
  MOTION_SEMANTIC_CACHE_FILE_SCHEMA,
  parseMotionSemanticFeatureCache,
} from './motion-semantic-cache-file.ts'
import type { MotionSemanticFeature } from '@rayure/protocol'
import type { MotionSemanticFeatureEncodeInput } from './motion-semantic-cache.ts'
import type { MotionSemanticFeatureEncoder } from './motion-semantic-cache.ts'

export const TEXT_ENCODER_REQUEST_SCHEMA = 'rayure.text-encoder-request.v1' as const
export const TEXT_ENCODER_RESPONSE_SCHEMA = 'rayure.text-encoder-response.v1' as const
export const DEFAULT_TEXT_ENCODER_TIMEOUT_MS = 10_000
export const MAX_TEXT_ENCODER_RESPONSE_BYTES = 16 * 1024 * 1024

export interface TextEncoderApiClientOptions {
  endpoint: string
  timeoutMs?: number
  fetchImplementation?: typeof fetch
}

export class TextEncoderApiClient implements MotionSemanticFeatureEncoder {
  readonly #endpoint: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: TextEncoderApiClientOptions) {
    this.#endpoint = validateTextEncoderEndpoint(options.endpoint)
    this.#timeoutMs = validateTextEncoderTimeout(options.timeoutMs ?? DEFAULT_TEXT_ENCODER_TIMEOUT_MS)
    this.#fetch = options.fetchImplementation ?? fetch
  }

  async encode(input: MotionSemanticFeatureEncodeInput): Promise<MotionSemanticFeature> {
    const cacheKey = requireCacheKey(input.cacheKey)
    const canonicalPrompt = requireCanonicalPrompt(input.canonicalPrompt)
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), this.#timeoutMs)
    const signal = input.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([input.signal, timeoutController.signal])

    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema: TEXT_ENCODER_REQUEST_SCHEMA,
          cacheKey,
          canonicalPrompt,
        }),
        signal,
      })
      const body = await readResponseBody(response)
      if (!response.ok) throw new Error(`Text Encoder API returned HTTP status ${response.status}`)
      const feature = parseResponseFeature(body)
      if (feature.cacheKey !== cacheKey || feature.canonicalPrompt !== canonicalPrompt) {
        throw new Error('Text Encoder API returned a feature with a mismatched cache identity')
      }
      return feature
    }
    finally {
      clearTimeout(timeoutHandle)
    }
  }
}

export function validateTextEncoderEndpoint(value: unknown): string {
  return requireEndpoint(value)
}

export function validateTextEncoderTimeout(value: unknown): number {
  return requireTimeout(value)
}

async function readResponseBody(response: Response): Promise<string> {
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_TEXT_ENCODER_RESPONSE_BYTES) {
    throw new Error('Text Encoder API response exceeds 16 MiB')
  }
  return new TextDecoder().decode(body)
}

function parseResponseFeature(raw: string): MotionSemanticFeature {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Text Encoder API response must contain valid JSON')
  }
  const response = requireRecord(parsed, 'Text Encoder API response')
  requireExactKeys(response, ['schema', 'feature'], 'Text Encoder API response')
  if (response.schema !== TEXT_ENCODER_RESPONSE_SCHEMA) {
    throw new Error('Unsupported Text Encoder API response schema')
  }
  const features = parseMotionSemanticFeatureCache(JSON.stringify({
    schema: MOTION_SEMANTIC_CACHE_FILE_SCHEMA,
    entries: [response.feature],
  }))
  const feature = features[0]
  if (feature === undefined) throw new Error('Text Encoder API response did not contain a feature')
  return feature
}

function requireEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.trim() !== value) {
    throw new Error('Text Encoder endpoint must be a trimmed URL up to 2048 characters')
  }
  let endpoint: URL
  try {
    endpoint = new URL(value)
  }
  catch {
    throw new Error('Text Encoder endpoint must be a valid URL')
  }
  if (
    (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.search.length > 0
    || endpoint.hash.length > 0
  ) {
    throw new Error('Text Encoder endpoint must use HTTPS or loopback HTTP without credentials/query')
  }
  if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname)) {
    throw new Error('Text Encoder endpoint must use HTTPS for non-loopback hosts')
  }
  return endpoint.href
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function requireTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Text Encoder timeoutMs must be an integer from 250 through 60000')
  }
  return value
}

function requireCacheKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error('Text Encoder cacheKey is invalid')
  }
  return value
}

function requireCanonicalPrompt(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error('Text Encoder canonicalPrompt is invalid')
  }
  return value
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
