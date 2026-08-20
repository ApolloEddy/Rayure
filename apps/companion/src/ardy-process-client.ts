import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import {
  createArdyMotionCancel,
  createArdyMotionRequest,
  parseArdyMotionResponse,
  serializeArdyProcessMessage,
} from './ardy-process-protocol.ts'
import type { ArdyMotionResult } from './ardy-process-protocol.ts'
import type { MotionSemanticFeature } from '@rayure/protocol'
import type { ArdyKinematicConstraint } from './ardy-process-protocol.ts'
import type { CanonicalMotion } from '@rayure/protocol'

export const DEFAULT_ARDY_PROCESS_TIMEOUT_MS = 30_000
export const MAX_ARDY_PROCESS_LINE_BYTES = 64 * 1024 * 1024

export interface ArdyProcessClientOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  requestTimeoutMs?: number
}

export interface ArdyProcessGenerationInput {
  textFeature: MotionSemanticFeature
  numFrames: number
  numDenoisingSteps: number
  cfgWeight: number
  history?: CanonicalMotion
  constraints?: readonly ArdyKinematicConstraint[]
  signal?: AbortSignal | undefined
}

interface PendingRequest {
  requestId: string
  resolve: (result: ArdyMotionResult) => void
  reject: (cause: unknown) => void
  timeoutHandle: ReturnType<typeof setTimeout>
  abortSignal: AbortSignal | undefined
  abortHandler: (() => void) | undefined
}

export class ArdyProcessClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #requestTimeoutMs: number
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #pending: PendingRequest | undefined
  #closed = false

  constructor(options: ArdyProcessClientOptions) {
    const command = requireCommand(options.command)
    const args = requireArgs(options.args ?? [])
    const cwd = options.cwd === undefined ? undefined : requireCwd(options.cwd)
    this.#requestTimeoutMs = requireTimeout(options.requestTimeoutMs ?? DEFAULT_ARDY_PROCESS_TIMEOUT_MS)
    this.#child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#consumeStdout(chunk))
    this.#child.stderr.on('data', (chunk: string) => this.#consumeStderr(chunk))
    this.#child.on('error', cause => this.#handleProcessFailure(cause))
    this.#child.on('close', (code, signal) => {
      this.#closed = true
      if (this.#pending !== undefined) {
        this.#rejectPending(new Error(`ARDY process closed before response (code=${code ?? 'none'}, signal=${signal ?? 'none'}): ${this.#stderrSummary()}`))
      }
    })
  }

  async generate(input: ArdyProcessGenerationInput): Promise<ArdyMotionResult> {
    if (this.#closed || this.#child.exitCode !== null) throw new Error('ARDY process is closed or terminated')
    if (this.#pending !== undefined) throw new Error('ARDY process already has a pending generation request')
    if (input.signal?.aborted) throw new Error('ARDY generation aborted')

    const requestId = randomUUID()
    const request = createArdyMotionRequest({
      requestId,
      textFeature: input.textFeature,
      numFrames: input.numFrames,
      numDenoisingSteps: input.numDenoisingSteps,
      cfgWeight: input.cfgWeight,
      ...(input.history === undefined ? {} : { history: input.history }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    })
    const raw = `${serializeArdyProcessMessage(request)}\n`

    return await new Promise<ArdyMotionResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.#rejectPending(new Error('ARDY process request timeout'))
        void this.close()
      }, this.#requestTimeoutMs)
      const pending: PendingRequest = {
        requestId,
        resolve,
        reject,
        timeoutHandle,
        abortSignal: input.signal,
        abortHandler: undefined,
      }
      if (input.signal !== undefined) {
        pending.abortHandler = () => {
          this.#rejectPending(new Error('ARDY generation aborted'))
          void this.close()
        }
        input.signal.addEventListener('abort', pending.abortHandler, { once: true })
      }
      this.#pending = pending
      try {
        this.#child.stdin.write(raw)
      }
      catch (cause) {
        this.#rejectPending(cause)
        void this.close()
      }
    })
  }

  async close(): Promise<void> {
    if (this.#closed && this.#child.exitCode !== null) return
    this.#closed = true
    this.#rejectPending(new Error('ARDY process terminated'))
    try {
      this.#child.stdin.end()
    }
    catch {
      // The process may have already closed its stdin.
    }
    if (this.#child.exitCode === null) this.#child.kill()
    if (this.#child.exitCode !== null) return
    await Promise.race([
      once(this.#child, 'close').then(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ])
  }

  #consumeStdout(chunk: string): void {
    if (this.#closed) return
    this.#stdoutBuffer += chunk
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_ARDY_PROCESS_LINE_BYTES) {
      this.#handleProcessFailure(new Error('ARDY process response line exceeds 64 MiB'))
      void this.close()
      return
    }
    let newlineIndex = this.#stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1)
      if (line.length > 0 && this.#pending !== undefined) {
        const pending = this.#pending
        try {
          const result = parseArdyMotionResponse(line, pending.requestId)
          this.#settlePending(result)
        }
        catch (cause) {
          this.#rejectPending(cause)
        }
      }
      newlineIndex = this.#stdoutBuffer.indexOf('\n')
    }
  }

  #consumeStderr(chunk: string): void {
    this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-8_192)
  }

  #handleProcessFailure(cause: unknown): void {
    this.#closed = true
    const message = cause instanceof Error ? cause.message : String(cause)
    this.#rejectPending(new Error(`ARDY process failed: ${message}${this.#stderrSummary()}`))
  }

  #settlePending(result: ArdyMotionResult): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    clearTimeout(pending.timeoutHandle)
    this.#clearAbortListener(pending)
    pending.resolve(result)
  }

  #rejectPending(cause: unknown): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    clearTimeout(pending.timeoutHandle)
    this.#clearAbortListener(pending)
    pending.reject(cause)
  }

  #clearAbortListener(pending: PendingRequest): void {
    if (pending.abortHandler !== undefined && pending.abortSignal !== undefined) {
      pending.abortSignal.removeEventListener('abort', pending.abortHandler)
    }
    pending.abortHandler = undefined
  }

  #stderrSummary(): string {
    const trimmed = this.#stderrBuffer.trim()
    return trimmed.length === 0 ? '' : ` stderr=${trimmed.slice(-512)}`
  }
}

function requireCommand(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 2048
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error('ARDY process command must be a trimmed printable string up to 2048 characters')
  }
  return value
}

function requireArgs(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('ARDY process args must contain at most 64 items')
  for (const [index, arg] of value.entries()) {
    if (
      typeof arg !== 'string'
      || arg.length > 4096
      || arg.trim() !== arg
      || /[\u0000-\u001F\u007F]/u.test(arg)
    ) {
      throw new Error(`ARDY process arg ${index} is invalid`)
    }
  }
  return value
}

function requireCwd(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new Error('ARDY process cwd must be an absolute path')
  }
  return value
}

function requireTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 250 || value > 120_000) {
    throw new Error('ARDY process requestTimeoutMs must be an integer from 250 through 120000')
  }
  return value
}
