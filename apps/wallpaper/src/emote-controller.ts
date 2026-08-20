import type { MotionDescriptor } from '@rayure/protocol'
import type { ExpressionController } from './expression-controller.ts'
import type { MotionController } from './motion-controller.ts'

export interface EmotePreset {
  id: string
  displayName: string
  preferredMotionIds: readonly string[]
  expressionName?: string
  expressionWeight?: number
  expressionDurationMs?: number
  autoResetAfterMs?: number
  loop?: boolean
}

export const PRESET_EMOTES: readonly EmotePreset[] = [
  {
    id: 'wave',
    displayName: '抬手打招呼',
    preferredMotionIds: ['wave', 'greeting', '打招呼', '招手'],
    expressionName: 'smile',
    expressionWeight: 1.0,
    expressionDurationMs: 150,
    autoResetAfterMs: 3500,
  },
  {
    id: 'stretch',
    displayName: '晨间伸懒腰',
    preferredMotionIds: ['stretch', '伸懒腰', '舒展'],
    expressionName: 'smile',
    expressionWeight: 0.8,
    expressionDurationMs: 200,
    autoResetAfterMs: 7000,
  },
  {
    id: 'cross_arms',
    displayName: '自信抱胸',
    preferredMotionIds: ['cross_arms', '抱胸', '自信'],
    expressionName: 'smile',
    expressionWeight: 0.7,
    expressionDurationMs: 200,
    autoResetAfterMs: 3500,
  },
  {
    id: 'laugh',
    displayName: '开怀大笑',
    preferredMotionIds: ['laugh', '大笑', '开怀'],
    expressionName: 'smile',
    expressionWeight: 1.0,
    expressionDurationMs: 150,
    autoResetAfterMs: 3200,
  },
  {
    id: 'pout',
    displayName: '傲娇轻哼',
    preferredMotionIds: ['pout', '傲娇', '轻哼', '扭头'],
    expressionName: 'smile',
    expressionWeight: 0.3,
    expressionDurationMs: 200,
    autoResetAfterMs: 2800,
  },
  {
    id: 'kiss',
    displayName: '浪漫飞吻',
    preferredMotionIds: ['kiss', '飞吻', '互动'],
    expressionName: 'wink',
    expressionWeight: 1.0,
    expressionDurationMs: 150,
    autoResetAfterMs: 2900,
  },
  {
    id: 'surprise',
    displayName: '惊讶探看',
    preferredMotionIds: ['surprise', '惊讶', '好奇'],
    expressionName: 'wink',
    expressionWeight: 0.6,
    expressionDurationMs: 200,
    autoResetAfterMs: 6500,
  },
  {
    id: 'shy',
    displayName: '害羞挠头',
    preferredMotionIds: ['shy', '害羞', '傻笑'],
    expressionName: 'smile',
    expressionWeight: 0.8,
    expressionDurationMs: 150,
    autoResetAfterMs: 3100,
  },
  {
    id: 'clap',
    displayName: '击掌领悟',
    preferredMotionIds: ['clap', '击掌', '领悟', '恍然'],
    expressionName: 'smile',
    expressionWeight: 0.9,
    expressionDurationMs: 150,
    autoResetAfterMs: 4600,
  },
  {
    id: 'turn_head',
    displayName: '侧身回眸',
    preferredMotionIds: ['turn_head', '回头', '回眸', '顾盼'],
    expressionName: 'smile',
    expressionWeight: 0.8,
    expressionDurationMs: 150,
    autoResetAfterMs: 2500,
  },
  {
    id: 'idle',
    displayName: '自然待机',
    preferredMotionIds: ['idle', '待机', '呼吸'],
    loop: true,
  },
]

export interface PlayEmoteOptions {
  emoteId: string
  motionId?: string | undefined
  expressionName?: string | undefined
  expressionWeight?: number | undefined
  durationMs?: number | undefined
}

export class EmoteController {
  private readonly motionController: MotionController
  private readonly expressionController: ExpressionController
  private motionCatalog = new Map<string, MotionDescriptor>()
  private activeResetTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    motionController: MotionController,
    expressionController: ExpressionController,
  ) {
    this.motionController = motionController
    this.expressionController = expressionController
  }

  updateCatalog(motions: readonly MotionDescriptor[]): void {
    this.motionCatalog.clear()
    for (const motion of motions) {
      this.motionCatalog.set(motion.id.toLowerCase(), motion)
    }
  }

  async playEmote(options: PlayEmoteOptions): Promise<boolean> {
    if (this.disposed) return false
    this.clearResetTimer()

    const rawId = options.emoteId ?? (options as any).preset ?? ''
    const normalizedId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
    const aliasMap: Record<string, string> = {
      greet: 'wave',
      nod: 'wave',
      proud: 'cross_arms',
      cheer: 'laugh',
      curious: 'surprise',
      quiet: 'shy',
      pray: 'wave',
      secret: 'shy',
    }
    const effectiveId = aliasMap[normalizedId] ?? normalizedId
    const preset = PRESET_EMOTES.find(p => p.id.toLowerCase() === effectiveId || p.id.toLowerCase() === normalizedId)

    // 1. 解析动作
    let targetMotion: MotionDescriptor | undefined
    if (options.motionId) {
      targetMotion = this.motionCatalog.get(options.motionId.toLowerCase())
    }
    else if (preset) {
      for (const candidate of preset.preferredMotionIds) {
        const found = this.motionCatalog.get(candidate.toLowerCase())
        if (found) {
          targetMotion = found
          break
        }
      }
    }

    // 2. 解析表情
    const exprName = options.expressionName ?? preset?.expressionName
    const exprWeight = options.expressionWeight ?? preset?.expressionWeight ?? 1.0
    const exprDuration = options.durationMs ?? preset?.expressionDurationMs ?? 200

    if (exprName) {
      this.expressionController.setExpression(exprName, exprWeight, exprDuration)
    }
    else if (preset?.id === 'idle') {
      this.expressionController.reset(300)
    }

    // 3. 播放动作
    let motionPlayed = false
    if (targetMotion) {
      const isLoop = preset?.loop ?? targetMotion.loop ?? false
      motionPlayed = await this.motionController.playMotion({
        ...targetMotion,
        loop: isLoop,
      }, () => {
        // 动作播放完毕自动重置表情
        if (!isLoop) {
          this.expressionController.reset(300)
        }
      })
    }

    // 4. 定时表情恢复兜底
    const autoResetMs = preset?.autoResetAfterMs
    if (autoResetMs && !preset?.loop) {
      this.activeResetTimer = setTimeout(() => {
        if (!this.disposed) {
          this.expressionController.reset(300)
        }
      }, autoResetMs)
    }

    return Boolean(motionPlayed || exprName)
  }

  private clearResetTimer(): void {
    if (this.activeResetTimer !== undefined) {
      clearTimeout(this.activeResetTimer)
      this.activeResetTimer = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearResetTimer()
    this.motionCatalog.clear()
  }
}
