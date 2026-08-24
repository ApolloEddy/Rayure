import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { createTtsProcessRequest, parseTtsProcessResponse, serializeTtsProcessRequest } from './tts-process-protocol.ts'
import type { TtsAdapter, TtsSynthesis } from './types.ts'

export const DEFAULT_TTS_PROCESS_TIMEOUT_MS = 30_000
export const MAX_TTS_PROCESS_LINE_BYTES = 24 * 1024 * 1024

export interface TtsProcessClientOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  requestTimeoutMs?: number
}

interface PendingRequest {
  requestId: string
  resolve: (synthesis: TtsSynthesis) => void
  reject: (cause: unknown) => void
  timeoutHandle: ReturnType<typeof setTimeout>
  abortSignal: AbortSignal | undefined
  abortHandler: (() => void) | undefined
}

/** Serializes one TTS request at a time and drops late provider responses. */
export class TtsProcessClient implements TtsAdapter {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #requestTimeoutMs: number
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #pending: PendingRequest | undefined
  #closed = false

  constructor(options: TtsProcessClientOptions) {
    const command = validateTtsProcessCommand(options.command)
    const args = validateTtsProcessArgs(options.args ?? [])
    const cwd = options.cwd === undefined ? undefined : validateTtsProcessCwd(options.cwd)
    this.#requestTimeoutMs = validateTtsProcessTimeout(options.requestTimeoutMs ?? DEFAULT_TTS_PROCESS_TIMEOUT_MS)
    this.#child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#consumeStdout(chunk))
    this.#child.stderr.on('data', (chunk: string) => this.#consumeStderr(chunk))
    this.#child.stdin.on('error', cause => this.#handleFailure(new Error(`TTS process stdin failed: ${cause.message}`)))
    this.#child.on('error', cause => this.#handleFailure(cause))
    this.#child.on('close', (code, signal) => {
      this.#closed = true
      if (this.#pending !== undefined) this.#rejectPending(new Error(`TTS process closed before response (code=${code ?? 'none'}, signal=${signal ?? 'none'})${this.#stderrSummary()}`))
    })
  }

  async synthesize(input: { speechId: string, text: string, signal: AbortSignal }): Promise<TtsSynthesis> {
    if (this.#closed || this.#child.exitCode !== null) throw new Error('TTS process is closed or terminated')
    if (this.#pending !== undefined) throw new Error('TTS process already has a pending request')
    if (input.signal.aborted) throw new Error('TTS synthesis aborted')
    const requestId = randomUUID()
    const raw = `${serializeTtsProcessRequest(createTtsProcessRequest({ requestId, speechId: input.speechId, text: input.text }))}\n`
    return await new Promise<TtsSynthesis>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.#rejectPending(new Error('TTS process request timeout'))
        void this.close()
      }, this.#requestTimeoutMs)
      const pending: PendingRequest = { requestId, resolve, reject, timeoutHandle, abortSignal: input.signal, abortHandler: undefined }
      pending.abortHandler = () => this.#rejectPending(new Error('TTS synthesis aborted'))
      input.signal.addEventListener('abort', pending.abortHandler, { once: true })
      this.#pending = pending
      try { this.#child.stdin.write(raw) } catch (cause) { this.#rejectPending(cause); void this.close() }
    })
  }

  async close(): Promise<void> {
    if (this.#closed && this.#child.exitCode !== null) return
    this.#closed = true
    this.#rejectPending(new Error('TTS process terminated'))
    try { this.#child.stdin.end() } catch { /* process may already be closed */ }
    const closePromise = this.#child.exitCode !== null ? Promise.resolve() : once(this.#child, 'close').then(() => undefined)
    if (this.#child.exitCode === null) this.#child.kill()
    await Promise.race([closePromise, new Promise<void>(resolve => setTimeout(resolve, 2_000))])
  }

  #consumeStdout(chunk: string): void {
    if (this.#closed) return
    this.#stdoutBuffer += chunk
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_TTS_PROCESS_LINE_BYTES) {
      this.#handleFailure(new Error('TTS process response line exceeds 24 MiB'))
      void this.close()
      return
    }
    let newlineIndex = this.#stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1)
      const pending = this.#pending
      if (line.length > 0 && pending !== undefined) {
        try {
          if (isStaleResponse(line, pending.requestId)) continue
          this.#settlePending(parseTtsProcessResponse(line, pending.requestId))
        }
        catch (cause) { this.#rejectPending(cause) }
      }
      newlineIndex = this.#stdoutBuffer.indexOf('\n')
    }
  }

  #consumeStderr(chunk: string): void { this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-8_192) }
  #handleFailure(cause: unknown): void {
    this.#closed = true
    this.#rejectPending(new Error(`TTS process failed: ${cause instanceof Error ? cause.message : String(cause)}${this.#stderrSummary()}`))
  }
  #settlePending(synthesis: TtsSynthesis): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    clearTimeout(pending.timeoutHandle)
    this.#clearAbort(pending)
    pending.resolve(synthesis)
  }
  #rejectPending(cause: unknown): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    clearTimeout(pending.timeoutHandle)
    this.#clearAbort(pending)
    pending.reject(cause)
  }
  #clearAbort(pending: PendingRequest): void {
    if (pending.abortHandler !== undefined && pending.abortSignal !== undefined) pending.abortSignal.removeEventListener('abort', pending.abortHandler)
    pending.abortHandler = undefined
  }
  #stderrSummary(): string {
    const text = this.#stderrBuffer.replace(/[\r\n\u0000-\u001F\u007F]+/gu, ' ').trim()
    return text.length === 0 ? '' : ` stderr=${text.slice(-512)}`
  }
}

function isStaleResponse(line: string, expectedRequestId: string): boolean {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    return typeof value.requestId === 'string' && value.requestId !== expectedRequestId
  }
  catch { return false }
}

export function validateTtsProcessCommand(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error('TTS process command is invalid')
  return value
}
export function validateTtsProcessArgs(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('TTS process args must contain at most 64 items')
  for (const [index, arg] of value.entries()) if (typeof arg !== 'string' || arg.length > 4096 || arg.trim() !== arg || /[\u0000-\u001F\u007F]/u.test(arg)) throw new Error(`TTS process arg ${index} is invalid`)
  return value
}
export function validateTtsProcessCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value || value.includes('\u0000') || !isAbsolute(value)) throw new Error('TTS process cwd must be an absolute path')
  return value
}
export function validateTtsProcessTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 250 || (value as number) > 120_000) throw new Error('TTS process timeout must be an integer from 250 through 120000')
  return value as number
}
