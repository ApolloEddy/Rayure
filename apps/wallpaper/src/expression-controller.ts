import type { Mesh, SkinnedMesh } from 'three'

export interface ExpressionControllerOptions {
  autoBlink?: boolean
  blinkMinInterval?: number
  blinkMaxInterval?: number
  random?: () => number
}

export type SemanticExpression =
  | 'blink'
  | 'blink_left'
  | 'blink_right'
  | 'smile'
  | 'surprise'
  | 'angry'
  | 'sad'
  | 'talk_a'
  | 'talk_i'
  | 'talk_u'
  | 'talk_e'
  | 'talk_o'

const SEMANTIC_MORPH_ALIASES: Record<SemanticExpression, readonly string[]> = {
  blink: ['まばたき', 'blink', '眨眼', '閉眼', 'eye_close', 'eyeclose', '両目閉', '閉じる'],
  blink_left: ['ウィンク右', 'wink_l', 'wink_left', '眨眼左', '左目閉', 'ウィンク'],
  blink_right: ['ウィンク', 'wink_r', 'wink_right', '眨眼右', '右目閉', 'ウィンク2'],
  smile: ['笑い', 'smile', '微笑', 'joy', 'happy', 'にこり', 'ニコッ', '口角上げ'],
  surprise: ['びっくり', 'surprise', '惊讶', '驚き', '目見開き', '見開き'],
  angry: ['怒り', 'angry', '愤怒', '怒る', '眉怒り'],
  sad: ['困る', 'sad', '困惑', '悲しみ', '眉困り', '下がり眉'],
  talk_a: ['あ', 'a', 'A', '口型あ', 'mouth_a', 'あー'],
  talk_i: ['い', 'i', 'I', '口型い', 'mouth_i', 'いー'],
  talk_u: ['う', 'u', 'U', '口型う', 'mouth_u', 'うー'],
  talk_e: ['え', 'e', 'E', '口型え', 'mouth_e', 'えー'],
  talk_o: ['お', 'o', 'O', '口型お', 'mouth_o', 'おー'],
}

export interface ActiveMorphTarget {
  name: string
  index: number
  currentWeight: number
  targetWeight: number
  transitionSpeed: number // 权重/秒
}

export class ExpressionController {
  readonly #mesh: Mesh | SkinnedMesh
  readonly #dictionary: Record<string, number>
  readonly #influences: number[]
  readonly #aliasIndexMap = new Map<SemanticExpression, number>()
  readonly #customTargets = new Map<number, ActiveMorphTarget>()
  readonly #random: () => number
  #autoBlink: boolean
  #blinkMinInterval: number
  #blinkMaxInterval: number
  #blinkState: 'idle' | 'closing' | 'opening' = 'idle'
  #blinkTimer = 0
  #blinkWeight = 0
  #disposed = false

  constructor(mesh: Mesh | SkinnedMesh, options: ExpressionControllerOptions = {}) {
    this.#mesh = mesh
    this.#dictionary = mesh.morphTargetDictionary ?? {}
    this.#influences = mesh.morphTargetInfluences ?? []
    this.#random = options.random ?? Math.random
    this.#autoBlink = options.autoBlink ?? true
    this.#blinkMinInterval = Math.max(0.5, options.blinkMinInterval ?? 2.5)
    this.#blinkMaxInterval = Math.max(this.#blinkMinInterval, options.blinkMaxInterval ?? 5.5)

    this.#buildSemanticMap()
    this.#scheduleNextBlink()
  }

  get autoBlink(): boolean {
    return this.#autoBlink
  }

  set autoBlink(enabled: boolean) {
    this.#autoBlink = Boolean(enabled)
    if (!this.#autoBlink) {
      this.#blinkState = 'idle'
      this.#blinkWeight = 0
    }
  }

  hasMorph(name: string): boolean {
    if (this.#disposed) return false
    return this.#resolveMorphIndex(name) !== undefined
  }

  getMorphWeight(name: string): number {
    if (this.#disposed) return 0
    const index = this.#resolveMorphIndex(name)
    if (index === undefined) return 0
    return this.#influences[index] ?? 0
  }

  setExpression(name: string, weight: number, durationMs = 150): void {
    if (this.#disposed) return
    const clampedWeight = Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 0))
    const index = this.#resolveMorphIndex(name)
    if (index === undefined) return

    const currentWeight = this.#influences[index] ?? 0
    const durationSeconds = Math.max(0.01, durationMs / 1000)
    const transitionSpeed = Math.abs(clampedWeight - currentWeight) / durationSeconds

    this.#customTargets.set(index, {
      name,
      index,
      currentWeight,
      targetWeight: clampedWeight,
      transitionSpeed: Math.max(transitionSpeed, 0.001),
    })
  }

  reset(durationMs = 200): void {
    if (this.#disposed) return
    for (const [index, target] of this.#customTargets.entries()) {
      if (target.targetWeight !== 0) {
        this.setExpression(target.name, 0, durationMs)
      }
    }
  }

  advance(deltaSeconds: number): void {
    if (this.#disposed || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return
    let remaining = deltaSeconds
    while (remaining > 0) {
      const dt = Math.min(remaining, 0.05)
      this.#step(dt)
      remaining -= dt
    }
  }

  #step(dt: number): void {
    // 1. 更新自动眨眼状态机
    this.#updateBlink(dt)

    // 2. 更新自定义表情目标插值
    for (const [index, target] of this.#customTargets.entries()) {
      if (target.currentWeight === target.targetWeight) {
        if (target.targetWeight === 0) {
          this.#customTargets.delete(index)
        }
        continue
      }

      const diff = target.targetWeight - target.currentWeight
      const step = target.transitionSpeed * dt
      if (Math.abs(diff) <= step) {
        target.currentWeight = target.targetWeight
      }
      else {
        target.currentWeight += Math.sign(diff) * step
      }

      if (index < this.#influences.length) {
        this.#influences[index] = target.currentWeight
      }
    }

    // 3. 将眨眼叠加到 mesh（若该通道未被自定义表情锁定为 1）
    const blinkIndex = this.#aliasIndexMap.get('blink')
    if (blinkIndex !== undefined && blinkIndex < this.#influences.length) {
      const custom = this.#customTargets.get(blinkIndex)
      const baseWeight = custom ? custom.currentWeight : 0
      this.#influences[blinkIndex] = Math.min(1, Math.max(baseWeight, this.#blinkWeight))
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#customTargets.clear()
    this.#aliasIndexMap.clear()
  }

  #buildSemanticMap(): void {
    const dictLower = new Map<string, number>()
    for (const [key, index] of Object.entries(this.#dictionary)) {
      dictLower.set(key.toLowerCase(), index)
    }

    for (const [semanticKey, aliases] of Object.entries(SEMANTIC_MORPH_ALIASES) as [SemanticExpression, readonly string[]][]) {
      for (const alias of aliases) {
        // 先精确匹配
        if (alias in this.#dictionary) {
          this.#aliasIndexMap.set(semanticKey, this.#dictionary[alias]!)
          break
        }
        // 再小写匹配
        const lower = alias.toLowerCase()
        if (dictLower.has(lower)) {
          this.#aliasIndexMap.set(semanticKey, dictLower.get(lower)!)
          break
        }
      }
    }
  }

  #resolveMorphIndex(name: string): number | undefined {
    // 1. 查语义预设
    if (name in SEMANTIC_MORPH_ALIASES) {
      const mapped = this.#aliasIndexMap.get(name as SemanticExpression)
      if (mapped !== undefined) return mapped
    }
    // 2. 查原始字典
    if (name in this.#dictionary) return this.#dictionary[name]
    // 3. 不区分大小写匹配
    const lower = name.toLowerCase()
    for (const [key, index] of Object.entries(this.#dictionary)) {
      if (key.toLowerCase() === lower) return index
    }
    return undefined
  }

  #scheduleNextBlink(): void {
    const span = this.#blinkMaxInterval - this.#blinkMinInterval
    this.#blinkTimer = this.#blinkMinInterval + this.#random() * span
    this.#blinkState = 'idle'
  }

  #updateBlink(dt: number): void {
    if (!this.#autoBlink) return

    const BLINK_CLOSE_DURATION = 0.06 // 闭眼耗时 60ms
    const BLINK_OPEN_DURATION = 0.09 // 睁眼耗时 90ms

    if (this.#blinkState === 'idle') {
      this.#blinkTimer -= dt
      if (this.#blinkTimer <= 0) {
        this.#blinkState = 'closing'
      }
    }
    else if (this.#blinkState === 'closing') {
      this.#blinkWeight += dt / BLINK_CLOSE_DURATION
      if (this.#blinkWeight >= 1) {
        this.#blinkWeight = 1
        this.#blinkState = 'opening'
      }
    }
    else if (this.#blinkState === 'opening') {
      this.#blinkWeight -= dt / BLINK_OPEN_DURATION
      if (this.#blinkWeight <= 0) {
        this.#blinkWeight = 0
        this.#scheduleNextBlink()
      }
    }
  }
}
