/**
 * Curated preset catalog for the ARDY 3D debug workbench (`?3dDebug=1`).
 *
 * The dropdown drives the same semantic pipeline Companion runs in production:
 * a prompt is LLM2Vec-embedded (AutoDL batch feature cache), matched against
 * the `rayure.motion-semantic-cache.v1` shards under `motions/`, and ARDY
 * generates a Canonical Motion from the winning feature.  The labels below are
 * Chinese-facing; the prompts are the real canonical prompts lifted from
 * `motions/motion-features.index.json` so the embedding matches what was
 * batch-encoded on AutoDL.
 *
 * One preset is a direct-play fixture: it needs no Companion and no ARDY GPU
 * process, so the page stays debuggable for visuals even when the semantic
 * backend is down.
 */

export interface MotionDebugPreset {
  id: string
  label: string
  /** LLM2Vec semantic prompt (the text that gets embedded). */
  prompt: string
  /** Dev-only direct-play Canonical Motion fixture (served by the Vite plugin). */
  fixtureUrl?: string
}

export const MOTION_DEBUG_PRESETS: readonly MotionDebugPreset[] = [
  { id: 'wave.casual', label: '轻松挥手', prompt: 'A person waves their hand casually' },
  { id: 'walk.forward', label: '缓步向前', prompt: 'A person walks forward slowly' },
  { id: 'walk.backward', label: '向后踱步', prompt: 'A person walks backwards' },
  { id: 'run.accelerate', label: '起跑加速', prompt: 'A person gradually speeds up from a jog to a sprint' },
  { id: 'dance.arm-arc', label: '手臂弧线舞', prompt: 'A person sweeps both arms in a wide arc from their sides to above their head.' },
  { id: 'sit.chair', label: '坐向椅子', prompt: 'A person sits down on a chair' },
  { id: 'greet.bow', label: '弯腰鞠躬', prompt: 'A person bows forward from the waist' },
  { id: 'greet.attention-salute', label: '立正敬礼', prompt: 'A person stands still and looks straight ahead, then salutes with their right hand.' },
  { id: 'head.back.laugh', label: '仰头大笑', prompt: 'A person throws head back and laughs' },
  { id: 'idle.stand', label: '静止站立', prompt: 'A person stands still' },
  { id: 'idle.adjust-collar', label: '整理衣领', prompt: 'A person adjusts their collar with both hands' },
  { id: 'jump.air-turn', label: '空中转体', prompt: 'A person jumps and spins around mid-air' },
  { id: 'turn.back-hands-on-hips', label: '转身叉腰', prompt: 'A person turns away and puts hands on hips' },
]

export const MOTION_DEBUG_FIXTURE: MotionDebugPreset = {
  id: '__fixture.walk',
  label: '本地夹具 · 步行（无需 Companion）',
  prompt: 'A person walks forward slowly',
  fixtureUrl: '/@rayure-assets/walk-motion.json',
}

export const MOTION_DEBUG_ALL_PRESETS: readonly MotionDebugPreset[] = [
  ...MOTION_DEBUG_PRESETS,
  MOTION_DEBUG_FIXTURE,
]

/** Built-in 3D model choices for the workbench model dropdown. */
export interface MotionDebugModelChoice {
  id: string
  label: string
  /** `undefined` → CoreSkin mannequin; otherwise a PMX URL on the dev asset route. */
  modelUrl?: string
}

export const MOTION_DEBUG_MODELS: readonly MotionDebugModelChoice[] = [
  { id: 'core-skin', label: 'CoreSkin27 官方人偶（默认）' },
  { id: 'albedo', label: '阿贝多.pmx（开发夹具）', modelUrl: '/@rayure-assets/albedo.pmx' },
]
