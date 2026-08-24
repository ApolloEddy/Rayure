import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'

import { parseVisionObservation } from './vision-process-protocol.ts'
import type { VisionObservation } from './vision-process-protocol.ts'

export const DEFAULT_VISION_PROCESS_TIMEOUT_MS = 10_000
export const MAX_VISION_PROCESS_LINE_BYTES = 16 * 1024

export interface VisionProcessClientOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  startupTimeoutMs?: number
  onObservation: (observation: VisionObservation) => void
  onError?: (cause: Error) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export class VisionProcessClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #onObservation: (observation: VisionObservation) => void
  readonly #onError: ((cause: Error) => void) | undefined
  readonly #onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  readonly #startupTimeoutMs: number
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #closed = false
  #startedAt = Date.now()
  #observationCount = 0

  constructor(options: VisionProcessClientOptions) {
    const command = validateVisionProcessCommand(options.command)
    const args = validateVisionProcessArgs(options.args ?? [])
    const cwd = options.cwd === undefined ? undefined : validateVisionProcessCwd(options.cwd)
    this.#startupTimeoutMs = validateVisionProcessTimeout(options.startupTimeoutMs ?? DEFAULT_VISION_PROCESS_TIMEOUT_MS)
    this.#onObservation = options.onObservation
    this.#onError = options.onError
    this.#onExit = options.onExit
    this.#child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#consumeStdout(chunk))
    this.#child.stderr.on('data', (chunk: string) => this.#consumeStderr(chunk))
    this.#child.stdin.on('error', cause => this.#fail(new Error(`Vision process stdin failed: ${cause.message}`)))
    this.#child.on('error', cause => this.#fail(cause))
    this.#child.on('close', (code, signal) => {
      if (this.#closed) return
      this.#closed = true
      this.#onExit?.(code, signal)
      if (code !== 0 && code !== null) this.#fail(new Error(`Vision process exited with code ${code}${this.#stderrSummary()}`))
    })
    setTimeout(() => {
      if (!this.#closed && this.#child.exitCode === null && Date.now() - this.#startedAt >= this.#startupTimeoutMs && this.#observationCount === 0) {
        this.#fail(new Error(`Vision process produced no observation within ${this.#startupTimeoutMs} ms${this.#stderrSummary()}`))
      }
    }, this.#startupTimeoutMs).unref()
  }

  get pid(): number | undefined {
    return this.#child.pid
  }

  get closed(): boolean {
    return this.#closed || this.#child.exitCode !== null
  }

  async close(): Promise<void> {
    if (this.#closed && this.#child.exitCode !== null) return
    this.#closed = true
    try {
      this.#child.stdin.end()
    }
    catch {
      // The process may already have closed stdin.
    }
    const closePromise = this.#child.exitCode !== null
      ? Promise.resolve()
      : once(this.#child, 'close').then(() => undefined)
    if (this.#child.exitCode === null) this.#child.kill()
    await Promise.race([
      closePromise,
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ])
  }

  #consumeStdout(chunk: string): void {
    if (this.#closed) return
    this.#stdoutBuffer += chunk
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_VISION_PROCESS_LINE_BYTES) {
      this.#fail(new Error('Vision process response line exceeds 16 KiB'))
      void this.close()
      return
    }
    let newlineIndex = this.#stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        try {
          const observation = parseVisionObservation(line)
          this.#observationCount += 1
          this.#onObservation(observation)
        }
        catch (cause) {
          this.#fail(cause instanceof Error ? cause : new Error(String(cause)))
          void this.close()
          return
        }
      }
      newlineIndex = this.#stdoutBuffer.indexOf('\n')
    }
  }

  #consumeStderr(chunk: string): void {
    this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-4_096)
  }

  #fail(cause: Error): void {
    if (this.#closed) return
    this.#closed = true
    const message = cause.message.replace(/[\r\n\u0000-\u001F\u007F]+/gu, ' ').trim().slice(0, 512)
    this.#onError?.(new Error(`Vision process failed: ${message}${this.#stderrSummary()}`))
  }

  #stderrSummary(): string {
    const trimmed = this.#stderrBuffer.replace(/[\r\n\u0000-\u001F\u007F]+/gu, ' ').trim()
    return trimmed.length === 0 ? '' : ` stderr=${trimmed.slice(-512)}`
  }
}

export function validateVisionProcessCommand(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error('Vision process command must be a trimmed printable string up to 2048 characters')
  }
  return value
}

export function validateVisionProcessArgs(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Vision process args must contain at most 64 items')
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== 'string' || arg.length > 4_096 || arg.trim() !== arg || /[\u0000-\u001F\u007F]/u.test(arg)) {
      throw new Error(`Vision process arg ${index} is invalid`)
    }
  }
  return value
}

export function validateVisionProcessCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value || value.includes('\u0000') || !isAbsolute(value)) {
    throw new Error('Vision process cwd must be an absolute path')
  }
  return value
}

export function validateVisionProcessTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Vision process startupTimeoutMs must be an integer from 250 through 60000')
  }
  return value
}
