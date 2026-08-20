import type { Live2dMotionDescriptor } from '@rayure/protocol'

export interface Live2dMotionModelLike {
  startMotion(
    group: string,
    index: number,
    priority: number,
    onStartMotion?: () => void,
    onEndMotion?: () => void,
  ): Promise<unknown>
  stopMotions(): void
  getMotions?(): readonly string[]
}

export class Live2dMotionController {
  readonly #priority: number
  #model: Live2dMotionModelLike | undefined
  #active: Live2dMotionDescriptor | undefined
  #generation = 0
  #disposed = false

  constructor(options: { priority?: number } = {}) {
    this.#priority = options.priority ?? 3
    if (!Number.isSafeInteger(this.#priority) || this.#priority < 1 || this.#priority > 3) {
      throw new Error('Live2D motion priority must be an integer from 1 through 3')
    }
  }

  get activeMotionId(): string | undefined {
    return this.#active?.id
  }

  get isPlaying(): boolean {
    return this.#active !== undefined
  }

  bindModel(model: Live2dMotionModelLike | undefined): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#active = undefined
    this.#model = model
  }

  async playMotion(descriptor: Live2dMotionDescriptor): Promise<boolean> {
    if (this.#disposed || !this.#model) return false
    if (!isMotionAvailable(this.#model, descriptor)) return false

    const model = this.#model
    const generation = ++this.#generation
    this.#active = undefined
    try {
      // The renderer's Cubism queue already fades a replacement. Stopping the
      // old queue first makes the explicit replace/interrupt contract
      // deterministic even when the previous motion is still loading.
      model.stopMotions()
      let began = false
      const handle = await model.startMotion(
        descriptor.group,
        descriptor.index,
        this.#priority,
        () => {
          if (this.#isCurrent(generation, model)) {
            began = true
            this.#active = descriptor
          }
        },
        () => {
          if (this.#isCurrent(generation, model)) this.#active = undefined
        },
      )
      if (!this.#isCurrent(generation, model) || isInvalidMotionHandle(handle)) return false
      if (!began) this.#active = descriptor
      return true
    }
    catch {
      if (this.#isCurrent(generation, model)) this.#active = undefined
      return false
    }
  }

  stopMotion(motionId?: string): void {
    if (this.#disposed || !this.#model) return
    if (motionId !== undefined && this.#active?.id !== motionId) return
    this.#generation += 1
    this.#active = undefined
    this.#model.stopMotions()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#active = undefined
    this.#model = undefined
  }

  #isCurrent(generation: number, model: Live2dMotionModelLike): boolean {
    return !this.#disposed && generation === this.#generation && model === this.#model
  }
}

function isMotionAvailable(model: Live2dMotionModelLike, descriptor: Live2dMotionDescriptor): boolean {
  const motions = model.getMotions?.()
  if (!motions || motions.length === 0) return true
  return motions.includes(`${descriptor.group}_${descriptor.index}`)
}

function isInvalidMotionHandle(handle: unknown): boolean {
  return handle === undefined || handle === null || handle === -1
}
