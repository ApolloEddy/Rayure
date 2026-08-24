import type { BehaviorEvent, BehaviorPlan } from '../behavior/types.ts'
import { validateAgentOutput } from './types.ts'
import type { AgentAdapter, AsrTranscript } from './types.ts'

export const AGENT_REQUEST_VERSION = 'rayure.agent-request.v1' as const
export const AGENT_RESPONSE_VERSION = 'rayure.agent-response.v1' as const
const MAX_AGENT_RESPONSE_BYTES = 64 * 1024

export interface HttpAgentAdapterOptions {
  endpoint: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Provider-neutral loopback/HTTPS Agent adapter; credentials never enter config or logs. */
export function createHttpAgentAdapter(options: HttpAgentAdapterOptions): AgentAdapter {
  const endpoint = validateAgentEndpoint(options.endpoint)
  const timeoutMs = validateAgentTimeout(options.timeoutMs ?? 30_000)
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async plan(input): Promise<BehaviorPlan> {
      if (input.signal.aborted) throw new Error('Agent request aborted')
      const controller = new AbortController()
      const unlink = linkAbortSignal(input.signal, controller)
      const timeout = setTimeout(() => controller.abort('agent-timeout'), timeoutMs)
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            version: AGENT_REQUEST_VERSION,
            event: input.event,
            transcript: input.transcript,
          }),
          signal: controller.signal,
        })
        const body = await response.text()
        if (new TextEncoder().encode(body).byteLength > MAX_AGENT_RESPONSE_BYTES) throw new Error('Agent response exceeds 64 KiB')
        if (!response.ok) throw new Error(`Agent request failed with HTTP ${response.status}`)
        const root = parseAgentResponse(body)
        return validateAgentOutput(input.event, input.transcript, root.plan)
      }
      finally {
        clearTimeout(timeout)
        unlink()
      }
    },
  }
}

export function parseAgentResponse(raw: string): { version: typeof AGENT_RESPONSE_VERSION, plan: BehaviorPlan } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Agent response must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent response must be an object')
  const root = value as Record<string, unknown>
  if (Object.keys(root).sort().join('|') !== 'plan|version' || root.version !== AGENT_RESPONSE_VERSION) throw new Error('Agent response contains missing or unknown fields')
  if (!root.plan || typeof root.plan !== 'object' || Array.isArray(root.plan)) throw new Error('Agent response plan must be an object')
  return { version: AGENT_RESPONSE_VERSION, plan: root.plan as BehaviorPlan }
}

export function validateAgentEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error('Agent endpoint must be a printable URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Agent endpoint must be a valid URL') }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')))) throw new Error('Agent endpoint must be HTTPS or loopback HTTP without credentials/query')
  return url.href
}

export function validateAgentTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 250 || (value as number) > 120_000) throw new Error('Agent timeoutMs must be an integer from 250 through 120000')
  return value as number
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason ?? 'aborted')
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}
