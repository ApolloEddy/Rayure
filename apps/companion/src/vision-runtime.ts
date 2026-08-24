import { BehaviorOrchestrator } from './behavior/behavior-orchestrator.ts'
import { VisionEventDetector } from './vision-event-detector.ts'
import type { RayureMotionGeneratePreset, RayureVisionConfig } from './local-config.ts'
import { VisionBehaviorPolicy } from './vision-behavior-policy.ts'
import type { MotionGenerationController } from './motion-generation-controller.ts'
import { VisionProcessClient } from './vision-process-client.ts'
import type { VisionProcessClientOptions } from './vision-process-client.ts'

export interface VisionRuntimeOptions {
  config?: RayureVisionConfig
  orchestrator: BehaviorOrchestrator
  controller?: MotionGenerationController
  presets?: readonly RayureMotionGeneratePreset[]
  onError?: (cause: Error) => void
}

/** Owns the derived-observation process and translates its events into policy. */
export class VisionRuntime {
  readonly #client: VisionProcessClient | undefined
  readonly #detector: VisionEventDetector
  readonly #policy: VisionBehaviorPolicy

  constructor(options: VisionRuntimeOptions) {
    this.#detector = new VisionEventDetector()
    this.#policy = new VisionBehaviorPolicy({
      orchestrator: options.orchestrator,
      ...(options.controller === undefined ? {} : { controller: options.controller }),
      ...(options.presets === undefined ? {} : { presets: options.presets }),
      ...(options.config?.actions === undefined ? {} : { actions: options.config.actions }),
      onError: (event, cause) => options.onError?.(cause instanceof Error ? cause : new Error(String(cause))),
    })
    const config = options.config
    if (config?.enabled !== true) return
    const args = [
      ...config.args,
      '--camera-index', String(config.cameraIndex),
      '--fps', String(config.fps),
      '--width', String(config.width),
      '--height', String(config.height),
      ...(config.modelPath === undefined ? [] : ['--model', config.modelPath]),
    ]
    const clientOptions = {
      command: config.command,
      args,
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      onObservation: (observation: Parameters<VisionProcessClientOptions['onObservation']>[0]) => {
        for (const event of this.#detector.observe(observation)) {
          this.#policy.handle(event)
        }
      },
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    }
    this.#client = new VisionProcessClient({
      ...clientOptions,
    })
  }

  get enabled(): boolean {
    return this.#client !== undefined
  }

  async close(): Promise<void> {
    await this.#client?.close()
  }
}
