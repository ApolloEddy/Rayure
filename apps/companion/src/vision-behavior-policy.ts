import { BehaviorOrchestrator } from './behavior/behavior-orchestrator.ts'
import type { BehaviorSubmitResult } from './behavior/behavior-orchestrator.ts'
import { validateBehaviorEvent } from './behavior/types.ts'
import type { BehaviorEvent } from './behavior/types.ts'
import type { RayureMotionGeneratePreset, VisionActionType } from './local-config.ts'
import type { MotionGenerationController } from './motion-generation-controller.ts'

export interface VisionBehaviorPolicyOptions {
  orchestrator: BehaviorOrchestrator
  controller?: MotionGenerationController
  presets?: readonly RayureMotionGeneratePreset[]
  actions?: Partial<Record<VisionActionType, string>>
  onError?: (event: BehaviorEvent, cause: unknown) => void
}

/** Maps low-frequency derived vision events to allowlisted motion presets. */
export class VisionBehaviorPolicy {
  readonly #orchestrator: BehaviorOrchestrator
  readonly #controller: MotionGenerationController | undefined
  readonly #presets: ReadonlyMap<string, RayureMotionGeneratePreset>
  readonly #actions: Partial<Record<VisionActionType, string>>
  readonly #onError: ((event: BehaviorEvent, cause: unknown) => void) | undefined

  constructor(options: VisionBehaviorPolicyOptions) {
    this.#orchestrator = options.orchestrator
    this.#controller = options.controller
    this.#presets = new Map((options.presets ?? []).map(preset => [preset.id, preset]))
    this.#actions = options.actions ?? {}
    this.#onError = options.onError
  }

  handle(event: BehaviorEvent): BehaviorSubmitResult | 'unmapped' {
    const validated = validateBehaviorEvent(event)
    const actionId = this.#actions[validated.type as VisionActionType]
    if (actionId === undefined) return 'unmapped'
    const preset = this.#presets.get(actionId)
    if (preset === undefined || this.#controller === undefined) return 'unmapped'
    return this.#orchestrator.submitEvent(validated, async ({ signal }) => {
      try {
        await this.#controller!.submitIntent({
          id: preset.id,
          prompt: preset.prompt,
          ...(preset.numFrames === undefined ? {} : { numFrames: preset.numFrames }),
          ...(preset.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: preset.numDenoisingSteps }),
          ...(preset.cfgWeight === undefined ? {} : { cfgWeight: preset.cfgWeight }),
          signal,
        })
      }
      catch (cause) {
        if (!signal.aborted) this.#onError?.(validated, cause)
        throw cause
      }
    })
  }
}
