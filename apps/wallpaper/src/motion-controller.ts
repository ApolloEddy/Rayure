import type { MotionDescriptor } from '@rayure/protocol'
import type { ThreeMmdAnimation } from '@yohawing/three-mmd-loader'

export interface LoadableMmdAnimationHost {
  setAnimation?(animation: ThreeMmdAnimation): void
  clearAnimation?(): void
}

export interface MmdMotionLoaderLike {
  loadAnimation?(source: string): Promise<ThreeMmdAnimation>
}

export interface MotionControllerOptions {
  loader?: MmdMotionLoaderLike | undefined
  onMotionEnd?: ((motionId: string) => void) | undefined
}

export interface ActiveMotionState {
  descriptor: MotionDescriptor
  animation: ThreeMmdAnimation
  loop: boolean
  onFinished?: (() => void) | undefined
}

export class MotionController {
  readonly #loader: MmdMotionLoaderLike | undefined
  readonly #onMotionEnd: ((motionId: string) => void) | undefined
  #model: LoadableMmdAnimationHost | undefined
  #active: ActiveMotionState | undefined
  #generation = 0
  #motionElapsed = 0
  #disposed = false

  constructor(options: MotionControllerOptions = {}) {
    this.#loader = options.loader
    this.#onMotionEnd = options.onMotionEnd
  }

  get activeMotionId(): string | undefined {
    return this.#active?.descriptor.id
  }

  get isPlaying(): boolean {
    return this.#active !== undefined
  }

  bindModel(model: LoadableMmdAnimationHost | undefined): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#active = undefined
    this.#motionElapsed = 0
    this.#model = model
  }

  advance(deltaSeconds: number): number {
    if (!this.#active || deltaSeconds <= 0 || !Number.isFinite(deltaSeconds)) {
      return this.#motionElapsed
    }
    this.#motionElapsed += Math.min(deltaSeconds, 0.1)
    return this.#motionElapsed
  }

  async playMotion(
    descriptor: MotionDescriptor,
    onFinished?: (() => void) | undefined,
  ): Promise<boolean> {
    if (this.#disposed || !this.#model || !this.#loader?.loadAnimation) return false
    const generation = ++this.#generation

    try {
      const animation = await this.#loader.loadAnimation(descriptor.url)
      if (this.#disposed || generation !== this.#generation || !this.#model) {
        return false
      }

      this.#model.setAnimation?.(animation)
      this.#motionElapsed = 0
      this.#active = {
        descriptor,
        animation,
        loop: descriptor.loop ?? false,
        onFinished,
      }
      return true
    }
    catch {
      if (generation === this.#generation) {
        this.#active = undefined
        this.#motionElapsed = 0
      }
      return false
    }
  }

  stopMotion(motionId?: string): void {
    if (this.#disposed || !this.#active) return
    if (motionId !== undefined && this.#active.descriptor.id !== motionId) return

    this.#generation += 1
    const stoppedId = this.#active.descriptor.id
    this.#active = undefined
    this.#motionElapsed = 0
    this.#model?.clearAnimation?.()
    this.#onMotionEnd?.(stoppedId)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#active = undefined
    this.#motionElapsed = 0
    this.#model = undefined
  }
}
