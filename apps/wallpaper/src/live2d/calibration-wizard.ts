import type { Live2dCalibrationDescriptor } from '@rayure/protocol'

import type { Live2dNativeSurface, Live2dParameterRange } from './native-surface.ts'
import type {
  Live2dControl,
  Live2dNeutralPose,
  Live2dParameterBinding,
  Live2dRigProfile,
} from './rig-profile.ts'
import {
  LIVE2D_CONTROL_VALUES,
} from './rig-profile.ts'
import {
  createCalibrationBinding,
  missingCalibrationControls,
  serializeCalibration,
} from './calibration-core.ts'

export interface CalibrationWizardOptions {
  surface: Live2dNativeSurface
  baseProfile: Live2dRigProfile
  initialDisabledControls?: readonly string[]
  initialSkinHiddenPartIds?: readonly string[]
  initialNeutralPose?: Live2dNeutralPose
  /** Endpoint that accepts the serialized calibration via POST. */
  calibrationUrl?: string
  modelId: string
  onSaved?: (calibration: Live2dCalibrationDescriptor) => void
  onDismissed?: () => void
  /**
   * Sends an ARDY generation request so the model plays a full motion and the
   * user can verify the channel mapping visually. Returns a request id, or
   * false when Companion is unavailable. Absent in tests that stub the wizard.
   */
  onRequestMotionGeneration?: (prompt: string) => string | false
}

/** Preset descriptions must exist verbatim in the local 30011-entry feature
 *  cache (see motions/motion-features.json) so the companion resolves them
 *  without a Text Encoder. Anything not in that cache fails when no encoder
 *  is available, so presets are pinned to real cache entries. */
const MOTION_VERIFY_PRESETS: readonly { label: string, prompt: string }[] = [
  { label: '挥手', prompt: 'A person waves their hand casually' },
  { label: '走路', prompt: 'A person walks forward slowly' },
  { label: '跑步', prompt: 'A person runs swinging arms vigorously' },
  { label: '跳舞', prompt: 'A person sweeps both arms in a wide arc from their sides to above their head.' },
  { label: '下蹲', prompt: 'A person drops to one knee and adjusts the laces or strap on a shoe.' },
  { label: '跳跃', prompt: 'A person jumps up and down' },
]

interface MutableRigProfile {
  id: string
  joints: Live2dRigProfile['joints']
  parameters: Live2dParameterBinding[]
}

interface WizardState {
  profile: MutableRigProfile
  disabledControls: Set<string>
  skinHiddenPartIds: string[]
  neutralPose: Live2dNeutralPose | undefined
}

const CHANNEL_LABELS: Readonly<Record<Live2dControl, string>> = {
  headYaw: '头部 左右',
  headPitch: '头部 上下',
  headRoll: '头部 歪头',
  bodyYaw: '身体 左右',
  bodyPitch: '身体 前后',
  bodyRoll: '身体 侧倾',
  leftArmAngle: '左臂 抬起',
  rightArmAngle: '右臂 抬起',
  leftElbowAngle: '左肘 弯曲',
  rightElbowAngle: '右肘 弯曲',
  leftThighAngle: '左腿 抬起',
  rightThighAngle: '右腿 抬起',
  leftKneeBend: '左膝 弯曲',
  rightKneeBend: '右膝 弯曲',
  leftFootAngle: '左脚 踝',
  rightFootAngle: '右脚 踝',
  leftThighDepth: '左腿 前后',
  rightThighDepth: '右腿 前后',
  leftKneeDepth: '左膝 前后',
  rightKneeDepth: '右膝 前后',
  leftFootDepth: '左脚 前后',
  rightFootDepth: '右脚 前后',
  squat: '蹲起',
  legPhase: '步态 交替',
}

/**
 * Four-step model calibration wizard: ARDY channel mapping, scene part
 * selection, initial pose, and save. It drives the live model through the
 * native surface so users confirm parts visually instead of guessing ids.
 */
export class CalibrationWizard {
  readonly #surface: Live2dNativeSurface
  readonly #baseProfile: Live2dRigProfile
  readonly #calibrationUrl: string | undefined
  readonly #modelId: string
  readonly #onSaved: ((calibration: Live2dCalibrationDescriptor) => void) | undefined
  readonly #onDismissed: (() => void) | undefined
  readonly #onRequestMotionGeneration: ((prompt: string) => string | false) | undefined
  readonly #state: WizardState
  #root: HTMLElement | undefined
  #step = 1
  #ranges: readonly Live2dParameterRange[] = []
  #usedParameterIds = new Set<string>()
  #pendingChannel: Live2dControl | undefined
  #trialGeneration = 0
  #disposed = false
  #verifyRequestId: string | undefined
  #verifyStatus: HTMLElement | undefined
  #verifyTimeout: number | undefined
  #saving = false
  #saveError: string | undefined

  constructor(options: CalibrationWizardOptions) {
    this.#surface = options.surface
    this.#baseProfile = options.baseProfile
    this.#calibrationUrl = options.calibrationUrl
    this.#modelId = options.modelId
    this.#onSaved = options.onSaved
    this.#onDismissed = options.onDismissed
    this.#onRequestMotionGeneration = options.onRequestMotionGeneration
    this.#state = {
      profile: {
        id: options.baseProfile.id,
        joints: options.baseProfile.joints,
        parameters: [...options.baseProfile.parameters],
      },
      disabledControls: new Set(options.initialDisabledControls ?? []),
      skinHiddenPartIds: [...new Set(options.initialSkinHiddenPartIds ?? [])],
      neutralPose: options.initialNeutralPose,
    }
  }

  open(): void {
    if (this.#disposed) return
    this.#ranges = this.#surface.getParameterRanges()
    this.#usedParameterIds = new Set(this.#state.profile.parameters.map(binding => binding.parameterId))
    this.#surface.disableNativeMotion()
    this.#surface.stopGeneratedMotion()
    this.#build()
  }

  close(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#trialGeneration += 1
    this.#clearVerifyTimeout()
    this.#verifyRequestId = undefined
    this.#verifyStatus = undefined
    this.#root?.remove()
    this.#root = undefined
  }

  #dismiss(): void {
    if (this.#disposed || this.#saving) return
    const onDismissed = this.#onDismissed
    this.close()
    onDismissed?.()
  }

  #build(): void {
    const root = document.createElement('div')
    root.className = 'rayure-calibration-wizard'
    // Side-docked panel: the model stays visible and interactive on the left
    // so trial-motion feedback is always on screen while calibrating.
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;justify-content:flex-end;pointer-events:none;'
    const panel = document.createElement('div')
    panel.style.cssText = 'pointer-events:auto;width:min(420px,94vw);max-height:96vh;overflow:auto;background:rgba(26,26,32,0.94);border-left:1px solid rgba(255,255,255,0.12);padding:16px;'
    const stepContent = this.#buildStepContent()
    const header = this.#buildHeader()
    header.append(this.#buildCollapseToggle(panel, stepContent))
    panel.append(header, stepContent)
    root.append(panel)
    document.body.append(root)
    this.#root = root
  }

  #buildCollapseToggle(panel: HTMLElement, stepContent: HTMLElement): HTMLButtonElement {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.textContent = '收起 ▸'
    toggle.style.cssText = 'padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#a1a1aa;font-size:12px;cursor:pointer;'
    let collapsed = false
    toggle.addEventListener('click', () => {
      collapsed = !collapsed
      stepContent.style.display = collapsed ? 'none' : ''
      const header = toggle.parentElement
      const title = header?.querySelector<HTMLElement>('[data-wizard-title]')
      const steps = header?.querySelector<HTMLElement>('[data-wizard-steps]')
      if (title !== undefined && title !== null) title.style.display = collapsed ? 'none' : ''
      if (steps !== undefined && steps !== null) steps.style.display = collapsed ? 'none' : ''
      panel.style.width = collapsed ? 'auto' : 'min(420px,94vw)'
      panel.style.padding = collapsed ? '12px 8px' : '16px'
      panel.style.background = collapsed ? 'transparent' : 'rgba(26,26,32,0.94)'
      toggle.textContent = collapsed ? '▸' : '收起 ▸'
    })
    return toggle
  }

  #buildHeader(): HTMLElement {
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;'
    const title = document.createElement('div')
    title.dataset.wizardTitle = '1'
    title.style.cssText = 'font-weight:600;font-size:16px;'
    title.textContent = `模型标定向导 · ${this.#modelId}`
    const steps = document.createElement('div')
    steps.dataset.wizardSteps = '1'
    steps.style.cssText = 'display:flex;gap:8px;font-size:12px;color:#a1a1aa;'
    for (let i = 1; i <= 4; i += 1) {
      const chip = document.createElement('span')
      chip.dataset.step = String(i)
      chip.style.cssText = 'padding:2px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.15);'
      chip.textContent = i === 1 ? '① 通道' : i === 2 ? '② 部件' : i === 3 ? '③ 姿势' : '④ 保存'
      steps.append(chip)
    }
    const dismiss = button('稍后', () => this.#dismiss())
    dismiss.disabled = this.#saving
    dismiss.title = '放弃本次未保存修改并恢复已保存的模型状态'
    header.append(title, steps, dismiss)
    return header
  }

  #buildStepContent(): HTMLElement {
    const content = document.createElement('div')
    content.style.cssText = 'display:flex;flex-direction:column;gap:12px;'
    const body = document.createElement('div')
    if (this.#step === 1) body.append(this.#buildChannelStep())
    else if (this.#step === 2) body.append(this.#buildPartStep())
    else if (this.#step === 3) body.append(this.#buildPoseStep())
    else body.append(this.#buildSaveStep())
    content.append(body, this.#buildNav())
    return content
  }

  #buildNav(): HTMLElement {
    const nav = document.createElement('div')
    nav.style.cssText = 'display:flex;justify-content:space-between;gap:8px;margin-top:4px;'
    const back = button('← 上一步', () => {
      if (this.#step > 1) {
        this.#step -= 1
        this.#rerender()
      }
    })
    back.disabled = this.#step === 1
    const next = button(this.#step === 4 ? '完成' : '下一步 →', () => {
      if (this.#step < 4) {
        this.#step += 1
        this.#rerender()
      }
      else {
        void this.#save()
      }
    })
    next.disabled = this.#saving
    if (this.#step === 4 && this.#saving) next.textContent = '正在保存…'
    nav.append(back, next)
    return nav
  }

  #rerender(): void {
    const panel = this.#root?.firstElementChild as HTMLElement | undefined
    if (panel === undefined) return
    panel.innerHTML = ''
    const stepContent = this.#buildStepContent()
    const header = this.#buildHeader()
    header.append(this.#buildCollapseToggle(panel, stepContent))
    panel.append(header, stepContent)
    this.#updateStepChips(panel)
  }

  #updateStepChips(panel: HTMLElement): void {
    panel.querySelectorAll<HTMLElement>('[data-step]').forEach(chip => {
      const active = Number(chip.dataset.step) === this.#step
      chip.style.borderColor = active ? '#6054F1' : 'rgba(255,255,255,0.15)'
      chip.style.color = active ? '#CFD8FF' : '#a1a1aa'
    })
  }

  #buildChannelStep(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
    const intro = document.createElement('div')
    intro.style.cssText = 'font-size:12px;color:#a1a1aa;'
    intro.textContent = '用「自动试摆」让参数逐个动一遍，看到正确部位就点「锁定」。也可在搜索框输入参数名筛选后手动试摆。每次试摆都会自动归位。'
    wrap.append(intro)

    const missing = missingCalibrationControls(this.#state.profile, [...this.#state.disabledControls])
    if (missing.length > 0) {
      const missingTitle = document.createElement('div')
      missingTitle.style.cssText = 'font-weight:600;font-size:13px;color:#F87454;'
      missingTitle.textContent = `待标定通道（${missing.length}）`
      wrap.append(missingTitle)
      for (const control of missing) {
        wrap.append(this.#buildChannelRow(control))
      }
    }

    const mappedTitle = document.createElement('div')
    mappedTitle.style.cssText = 'font-weight:600;font-size:13px;margin-top:8px;'
    mappedTitle.textContent = '已映射通道'
    wrap.append(mappedTitle)
    for (const control of LIVE2D_CONTROL_VALUES) {
      const bindings = this.#state.profile.parameters.filter(candidate => candidate.control === control)
      if (bindings.length > 0) wrap.append(this.#buildMappedRow(control, bindings))
    }
    return wrap
  }

  #buildChannelRow(control: Live2dControl): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:#26262e;border-radius:8px;padding:8px 10px;'
    const label = document.createElement('div')
    label.style.cssText = 'width:120px;flex:none;font-size:13px;'
    label.textContent = CHANNEL_LABELS[control]
    row.append(label)

    const candidates = this.#ranges.filter(range => !this.#usedParameterIds.has(range.id))
    const search = document.createElement('input')
    search.type = 'text'
    search.maxLength = 128
    search.placeholder = '搜索参数名…'
    search.style.cssText = 'flex:0 1 120px;min-width:0;background:#1e1e24;color:#e5e5e5;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 6px;font-size:12px;'
    const select = document.createElement('select')
    select.style.cssText = 'flex:1 1 150px;min-width:0;background:#1e1e24;color:#e5e5e5;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 6px;font-size:12px;'
    const refreshOptions = (): void => {
      select.innerHTML = ''
      const query = search.value.trim().toLocaleLowerCase()
      const filtered = query.length === 0
        ? candidates
        : candidates.filter(range => range.id.toLocaleLowerCase().includes(query))
      select.append(new Option('选择参数…', ''))
      if (filtered.length === 0) {
        select.append(new Option('无匹配参数', ''))
        return
      }
      for (const group of groupParameters(filtered)) {
        const groupElement = document.createElement('optgroup')
        groupElement.label = group.label
        for (const range of group.items) {
          groupElement.append(new Option(`${range.id}  (${range.min} ~ ${range.max})`, range.id))
        }
        select.append(groupElement)
      }
    }
    refreshOptions()
    search.addEventListener('input', refreshOptions)
    row.append(search, select)

    const status = document.createElement('div')
    status.style.cssText = 'flex:1 1 100%;font-size:12px;color:#a1a1aa;min-height:16px;'
    row.append(status)

    const preview = button('试摆一次', () => {
      const parameterId = select.value
      if (!parameterId) return
      const range = this.#ranges.find(candidate => candidate.id === parameterId)
      if (range === undefined) return
      this.#trialGeneration += 1
      status.textContent = `试摆中：${range.id}`
      void this.#trialPose(range, this.#trialGeneration).then(() => {
        if (!this.#disposed) status.textContent = ''
      })
    })
    const auto = button('▶ 自动试摆', () => {
      this.#trialGeneration += 1
      const generation = this.#trialGeneration
      status.textContent = '自动试摆中…看到对的部位点「锁定」'
      void this.#autoTrial(control, candidates, select, status, generation)
    })
    const confirm = button('锁定为部位', () => {
      const parameterId = select.value
      if (!parameterId) return
      this.#trialGeneration += 1
      this.#bindParameter(control, parameterId)
    })
    const disable = button('此模型无此部位', () => {
      this.#trialGeneration += 1
      this.#state.disabledControls.add(control)
      this.#rerender()
    })
    disable.style.cssText += ';color:#a1a1aa;'
    row.append(preview, auto, confirm, disable)
    return row
  }

  #bindParameter(control: Live2dControl, parameterId: string): void {
    if (!parameterId) return
    const range = this.#ranges.find(candidate => candidate.id === parameterId)
    if (range === undefined) return
    this.#surface.previewParameter(parameterId, range.defaultValue)
    this.#state.profile.parameters.push(createCalibrationBinding(control, range))
    this.#usedParameterIds.add(parameterId)
    this.#pendingChannel = undefined
    this.#rerender()
  }

  async #trialPose(range: Live2dParameterRange, generation: number): Promise<void> {
    // Reset first so residue from an earlier trial never distorts what the
    // user is looking at, then sweep the target parameter back and forth with
    // per-frame interpolation: the motion stays continuous instead of jumping
    // between two frozen extremes, and each step completes only after the
    // model reads back the target value.
    this.#surface.resetParameterDefaults()
    await this.#settle(generation)
    for (let i = 0; i < 2; i += 1) {
      if (generation !== this.#trialGeneration || this.#disposed) return
      await this.#sweepTo(range, range.max, generation)
      await this.#holdFrames(12, generation)
      if (generation !== this.#trialGeneration || this.#disposed) return
      await this.#sweepTo(range, range.min, generation)
      await this.#holdFrames(12, generation)
    }
    if (generation !== this.#trialGeneration || this.#disposed) return
    await this.#sweepTo(range, range.defaultValue, generation)
  }

  /** Interpolates the parameter toward the target over rendered frames. */
  async #sweepTo(range: Live2dParameterRange, target: number, generation: number): Promise<void> {
    const start = this.#surface.getParameterValue(range.id)
    const from = start !== undefined && Number.isFinite(start) ? start : target
    const totalFrames = 14
    for (let frame = 1; frame <= totalFrames; frame += 1) {
      if (generation !== this.#trialGeneration || this.#disposed) return
      const alpha = frame / totalFrames
      this.#surface.previewParameter(range.id, from + (target - from) * alpha)
      await nextFrame()
    }
    // Land exactly on the target and confirm the model actually reads it back.
    this.#surface.previewParameter(range.id, target)
    await this.#settleTo(range, target, generation)
  }

  /** Waits until the model actually reads back the target value before moving on. */
  async #settleTo(range: Live2dParameterRange, target: number, generation: number): Promise<void> {
    const tolerance = Math.max(1e-4, (range.max - range.min) * 0.02)
    const startedAt = performance.now()
    while (generation === this.#trialGeneration && !this.#disposed) {
      const value = this.#surface.getParameterValue(range.id)
      if (value !== undefined && Math.abs(value - target) <= tolerance) return
      if (performance.now() - startedAt > 2500) return
      await nextFrame()
    }
  }

  /** Waits one rendered frame so the reset pose is visible before the first swing. */
  async #settle(generation: number): Promise<void> {
    if (generation === this.#trialGeneration && !this.#disposed) await nextFrame()
  }

  /** Holds the current pose for `frames` rendered frames (frame-driven, not time-driven). */
  async #holdFrames(frames: number, generation: number): Promise<void> {
    for (let frame = 0; frame < frames && generation === this.#trialGeneration && !this.#disposed; frame += 1) {
      await nextFrame()
    }
  }

  async #autoTrial(
    control: Live2dControl,
    candidates: readonly Live2dParameterRange[],
    select: HTMLSelectElement,
    status: HTMLElement,
    generation: number,
  ): Promise<void> {
    for (const range of candidates) {
      if (generation !== this.#trialGeneration || this.#disposed) return
      select.value = range.id
      status.textContent = `试摆中：${range.id}`
      await this.#trialPose(range, generation)
      if (generation !== this.#trialGeneration || this.#disposed) return
      status.textContent = `当前：${range.id} —— 若这就是「${CHANNEL_LABELS[control]}」点「锁定为部位」`
      await this.#holdFrames(30, generation)
    }
    if (generation === this.#trialGeneration && !this.#disposed) status.textContent = '自动试摆结束'
  }

  #buildMappedRow(control: Live2dControl, bindings: readonly Live2dParameterBinding[]): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:#26262e;border-radius:8px;padding:8px 10px;'
    const label = document.createElement('div')
    label.style.cssText = 'width:120px;flex:none;font-size:13px;color:#a1a1aa;'
    label.textContent = CHANNEL_LABELS[control]
    row.append(label)

    const params = document.createElement('div')
    params.style.cssText = 'flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:4px;'
    for (const binding of bindings) {
      const item = document.createElement('div')
      item.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;'
      const name = document.createElement('span')
      name.style.cssText = 'flex:1;color:#CFD8FF;min-width:0;overflow:hidden;text-overflow:ellipsis;'
      name.textContent = binding.parameterId + (binding.invert === true ? '（反向）' : '')
      const invert = button(binding.invert === true ? '方向✓' : '反转', () => {
        this.#replaceBinding(control, binding.parameterId, binding.invert === true ? undefined : true)
      })
      const remove = button('移除', () => {
        this.#state.profile.parameters = this.#state.profile.parameters.filter(
          candidate => !(candidate.control === control && candidate.parameterId === binding.parameterId),
        )
        this.#usedParameterIds.delete(binding.parameterId)
        this.#rerender()
      })
      remove.style.cssText += ';color:#F87454;'
      item.append(name, invert, remove)
      params.append(item)
    }
    row.append(params)

    // A part can be driven by several parameters: allow appending more.
    const candidates = this.#ranges.filter(range => !this.#usedParameterIds.has(range.id))
    const appendSelect = document.createElement('select')
    appendSelect.style.cssText = 'flex:1 1 140px;min-width:0;background:#1e1e24;color:#e5e5e5;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 6px;font-size:12px;'
    appendSelect.append(new Option('追加参数…', ''))
    for (const group of groupParameters(candidates)) {
      const groupElement = document.createElement('optgroup')
      groupElement.label = group.label
      for (const range of group.items) {
        groupElement.append(new Option(range.id, range.id))
      }
      appendSelect.append(groupElement)
    }
    const append = button('追加到部位', () => {
      const parameterId = appendSelect.value
      if (!parameterId) return
      this.#bindParameter(control, parameterId)
    })
    row.append(appendSelect, append)
    return row
  }

  #replaceBinding(control: Live2dControl, parameterId: string, invert: boolean | undefined): void {
    const index = this.#state.profile.parameters.findIndex(
      candidate => candidate.control === control && candidate.parameterId === parameterId,
    )
    if (index === -1) return
    const existing = this.#state.profile.parameters[index]!
    this.#state.profile.parameters[index] = invert === undefined
      ? {
          parameterId: existing.parameterId,
          control: existing.control,
          min: existing.min,
          max: existing.max,
          neutral: existing.neutral,
          ...(existing.scale === undefined ? {} : { scale: existing.scale }),
          ...(existing.mode === undefined ? {} : { mode: existing.mode }),
        }
      : { ...existing, invert }
    this.#rerender()
  }

  #buildPartStep(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
    const intro = document.createElement('div')
    intro.style.cssText = 'font-size:12px;color:#a1a1aa;'
    intro.textContent = '勾选会从默认视图隐藏的部件（背景 / 地板 / 特效层）。勾选后立即在模型上生效预览。'
    wrap.append(intro)
    const partIds = this.#surface.getPartIds()
    if (partIds.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'font-size:13px;color:#a1a1aa;'
      empty.textContent = '模型未暴露可独立隐藏的部件。'
      wrap.append(empty)
      return wrap
    }
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;'
    for (const partId of partIds) {
      const item = document.createElement('label')
      item.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;background:#26262e;border-radius:6px;padding:6px 8px;'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = this.#state.skinHiddenPartIds.includes(partId)
      box.addEventListener('change', () => {
        if (box.checked) {
          this.#state.skinHiddenPartIds.push(partId)
          this.#surface.setPartOpacity(partId, 0)
        }
        else {
          this.#state.skinHiddenPartIds = this.#state.skinHiddenPartIds.filter(id => id !== partId)
          this.#surface.setPartOpacity(partId, 1)
        }
      })
      const name = document.createElement('span')
      name.textContent = partId
      item.append(box, name)
      grid.append(item)
    }
    wrap.append(grid)
    return wrap
  }

  #buildPoseStep(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
    const intro = document.createElement('div')
    intro.style.cssText = 'font-size:12px;color:#a1a1aa;'
    intro.textContent = '调整参数把模型摆成你想要的初始姿势（如站立、双手放下），然后「捕获当前姿势」。动作结束会回到这个姿势。'
    wrap.append(intro)
    wrap.append(this.#buildMotionVerifyBlock())
    const buttons = document.createElement('div')
    buttons.style.cssText = 'display:flex;gap:8px;'
    buttons.append(
      button('全部回默认', () => {
        this.#surface.resetParameterDefaults()
      }),
      button('捕获当前姿势为初始姿势', () => {
        const pose: Record<string, number> = {}
        for (const range of this.#ranges) {
          const value = this.#surface.getParameterValue(range.id)
          if (value !== undefined && Number.isFinite(value)) pose[range.id] = value
        }
        this.#state.neutralPose = pose
        this.#surface.resetParameterDefaults()
        for (const [id, value] of Object.entries(pose)) this.#surface.previewParameter(id, value)
      }),
    )
    wrap.append(buttons)

    if (this.#state.neutralPose !== undefined) {
      const captured = document.createElement('div')
      captured.style.cssText = 'font-size:12px;color:#1DC981;'
      captured.textContent = `已捕获初始姿势（${Object.keys(this.#state.neutralPose).length} 个参数）`
      wrap.append(captured)
    }

    const mappedTitle = document.createElement('div')
    mappedTitle.style.cssText = 'font-weight:600;font-size:13px;margin-top:8px;'
    mappedTitle.textContent = '微调（映射通道）'
    wrap.append(mappedTitle)

    for (const binding of this.#state.profile.parameters) {
      wrap.append(this.#buildPoseSlider(binding))
    }
    return wrap
  }

  #buildMotionVerifyBlock(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;background:#1f2027;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;'
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:600;font-size:13px;'
    title.textContent = 'ARDY 动作验证（检查映射是否正确）'
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:12px;color:#a1a1aa;'
    hint.textContent = '点一个动作让 ARDY 生成并播放到模型上，肉眼看姿势是否符合描述。预置动作已在本地特征库中，首次生成约 10–60 秒，再次点击立即播放；自由输入仅当该描述已在库中（或无 Text Encoder 时）才能生成。播放结束模型回到初始姿势。'
    const presets = document.createElement('div')
    presets.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;'
    for (const preset of MOTION_VERIFY_PRESETS) {
      presets.append(button(preset.label, () => {
        this.#requestMotionVerify(preset.prompt, status)
      }))
    }
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:6px;'
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 512
    input.placeholder = '或输入动作描述，如：A person claps their hands'
    input.style.cssText = 'flex:1;min-width:0;background:#26262e;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 8px;color:#e4e4e7;font-size:12px;'
    row.append(input, button('生成并播放', () => {
      const prompt = input.value.trim()
      if (prompt.length === 0) {
        status.textContent = '请输入动作描述'
        return
      }
      this.#requestMotionVerify(prompt, status)
    }))
    const status = document.createElement('div')
    status.style.cssText = 'font-size:12px;color:#a1a1aa;min-height:16px;'
    status.textContent = this.#onRequestMotionGeneration === undefined
      ? 'Companion 不可用（无法生成动作）'
      : '等待发送'
    wrap.append(title, hint, presets, row, status)
    return wrap
  }

  #requestMotionVerify(prompt: string, status: HTMLElement): void {
    if (this.#onRequestMotionGeneration === undefined) {
      status.textContent = 'Companion 不可用（无法生成动作）'
      return
    }
    this.#clearVerifyTimeout()
    this.#verifyStatus = status
    this.#verifyRequestId = undefined
    const result = this.#onRequestMotionGeneration(prompt)
    if (result === false) {
      this.#verifyStatus = undefined
      status.textContent = '请求失败：Companion 未连接'
      return
    }
    this.#verifyRequestId = result
    status.textContent = '请求已发送 · ARDY 正在生成（通常 10–60 秒，相同动作二次请求即刻播放）…'
    this.#verifyTimeout = window.setTimeout(() => {
      if (this.#verifyStatus !== undefined) {
        this.#verifyStatus.textContent = '生成超时：请查看 Companion 窗口的 motion.generate.error 日志'
      }
      this.#verifyRequestId = undefined
      this.#verifyStatus = undefined
      this.#verifyTimeout = undefined
    }, 75_000)
  }

  #clearVerifyTimeout(): void {
    if (this.#verifyTimeout !== undefined) {
      window.clearTimeout(this.#verifyTimeout)
      this.#verifyTimeout = undefined
    }
  }

  /**
   * Reflects a companion motion.generate.status event into the verify block.
   * The companion client receives these on every intent, so the request id is
   * matched against the wizard's pending request before showing anything.
   */
  reportMotionGenerateStatus(status: { requestId: string, phase: 'accepted' | 'failed', message?: string }): void {
    if (this.#verifyRequestId === undefined || status.requestId !== this.#verifyRequestId) return
    if (status.phase === 'failed') {
      this.#clearVerifyTimeout()
      if (this.#verifyStatus !== undefined) {
        this.#verifyStatus.textContent = `生成失败：${status.message ?? '未知错误'}（请查看 Companion 日志）`
      }
      this.#verifyRequestId = undefined
      this.#verifyStatus = undefined
    }
    else if (this.#verifyStatus !== undefined) {
      this.#verifyStatus.textContent = 'ARDY 正在生成动作…（10–60 秒，生成后自动播放）'
    }
  }

  /** Reflects only this wizard request's motion.published event into the verify block. */
  reportMotionPublished(motionId: string, displayName: string): void {
    if (this.#verifyRequestId === undefined || !motionId.startsWith(`${this.#verifyRequestId}-`)) return
    this.#clearVerifyTimeout()
    if (this.#verifyStatus !== undefined) {
      this.#verifyStatus.textContent = `✓ 动作已生成并开始播放（${displayName}）· 播放结束模型回到初始姿势`
    }
    this.#verifyRequestId = undefined
    this.#verifyStatus = undefined
  }

  #buildPoseSlider(binding: Live2dParameterBinding): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#26262e;border-radius:8px;padding:6px 10px;font-size:12px;'
    const label = document.createElement('span')
    label.style.cssText = 'width:110px;flex:none;color:#a1a1aa;'
    label.textContent = CHANNEL_LABELS[binding.control]
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = String(binding.min)
    slider.max = String(binding.max)
    slider.step = String((binding.max - binding.min) / 100 || 1)
    slider.value = String(binding.neutral)
    slider.style.cssText = 'flex:1;'
    slider.addEventListener('input', () => {
      this.#surface.previewParameter(binding.parameterId, Number(slider.value))
    })
    const value = document.createElement('span')
    value.style.cssText = 'width:52px;text-align:right;color:#CFD8FF;'
    value.textContent = slider.value
    slider.addEventListener('input', () => {
      value.textContent = slider.value
    })
    row.append(label, slider, value)
    return row
  }

  #buildSaveStep(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
    const summary = document.createElement('div')
    summary.style.cssText = 'background:#26262e;border-radius:8px;padding:10px 12px;font-size:12px;line-height:22px;'
    const mapped = this.#state.profile.parameters.length
    const disabled = this.#state.disabledControls.size
    const hiddenParts = this.#state.skinHiddenPartIds.length
    const hasPose = this.#state.neutralPose !== undefined
    summary.innerHTML = ''
    summary.append(
      line(`映射通道：${mapped}`),
      line(`禁用通道：${disabled}`),
      line(`隐藏部件：${hiddenParts}`),
      line(`初始姿势：${hasPose ? '已捕获' : '未捕获（使用模型默认）'}`),
    )
    wrap.append(summary)
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:12px;color:#a1a1aa;'
    hint.textContent = this.#calibrationUrl === undefined
      ? 'Companion 未提供可写校准端点；当前结果不能安全保存。'
      : '保存成功后会从本机 Rayure 状态目录重新加载，不会修改模型文件。'
    wrap.append(hint)
    if (this.#saveError !== undefined) {
      const error = document.createElement('div')
      error.style.cssText = 'font-size:12px;color:#F87454;white-space:pre-wrap;'
      error.textContent = this.#saveError
      wrap.append(error)
    }
    return wrap
  }

  async #save(): Promise<void> {
    if (this.#saving || this.#disposed) return
    if (this.#calibrationUrl === undefined) {
      this.#saveError = '无法保存：Companion 没有提供校准端点。请检查本机配置后重试。'
      this.#rerender()
      return
    }
    const calibration = serializeCalibration(
      this.#state.profile,
      [...this.#state.disabledControls],
      this.#state.neutralPose,
      this.#state.skinHiddenPartIds,
    )
    this.#saving = true
    this.#saveError = undefined
    this.#rerender()
    try {
      await this.#postCalibration(calibration)
      if (this.#disposed) return
      const onSaved = this.#onSaved
      this.close()
      onSaved?.(calibration)
    }
    catch (cause) {
      if (this.#disposed) return
      this.#saving = false
      this.#saveError = cause instanceof Error ? cause.message : '校准保存失败'
      this.#rerender()
    }
  }

  async #postCalibration(calibration: Live2dCalibrationDescriptor): Promise<void> {
    try {
      const response = await fetch(this.#calibrationUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calibration),
      })
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 160)
        throw new Error(`校准保存失败（HTTP ${response.status}）${detail.length === 0 ? '' : `：${detail}`}`)
      }
    }
    catch (cause) {
      if (cause instanceof Error) throw cause
      throw new Error('校准保存失败：无法连接 Companion')
    }
  }
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  element.style.cssText = 'padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:#2b2b33;color:#e5e5e5;font-size:12px;cursor:pointer;'
  element.addEventListener('click', onClick)
  return element
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()))
}

interface ParameterGroup {
  label: string
  items: readonly Live2dParameterRange[]
}

/**
 * Semantic keywords (matched case-insensitively anywhere in the id) mapped to
 * readable group names. Longer/more specific keys first so e.g. "EyeBall"
 * wins over "Eye" when both match.
 */
const PARAMETER_GROUP_RULES: readonly (readonly [string, string])[] = [
  ['eyeball', '眼球'],
  ['eye', '眼睛'],
  ['brow', '眉毛'],
  ['mouth', '嘴'],
  ['nose', '鼻子'],
  ['ear', '耳朵'],
  ['cheek', '脸颊'],
  ['face', '脸'],
  ['head', '头部'],
  ['hair', '头发'],
  ['body', '身体'],
  ['breast', '胸部'],
  ['arm', '手臂'],
  ['hand', '手'],
  ['finger', '手指'],
  ['shoulder', '肩'],
  ['elbow', '肘'],
  ['waist', '腰'],
  ['hip', '髋部'],
  ['skirt', '裙摆'],
  ['leg', '腿部'],
  ['knee', '膝盖'],
  ['foot', '脚'],
  ['ankle', '脚踝'],
  ['toe', '脚趾'],
  ['breath', '呼吸'],
  ['angle', '角度'],
  ['rotation', '旋转'],
  ['open', '开合'],
  ['form', '形状'],
  ['move', '位移'],
  ['zoom', '缩放'],
  ['opacity', '透明度'],
]

/** Shared prefix word (letters only) used for the fallback grouping. */
function leadingWord(id: string): string {
  const match = /^(?:Param_?)?([A-Za-z]+)/u.exec(id)
  return (match?.[1] ?? id).toLocaleLowerCase()
}

/**
 * Pinyin-initial dictionaries for the abbreviation naming used by bilibili
 * Unity-ripped models. Keys are the uppercase abbreviation exactly as it
 * appears in the id (after the Param prefix); values are the guessed Chinese
 * meaning shown as the group label. Guesses are annotated with "？" so the
 * user treats them as hints, never facts.
 */
const PINYIN_ABBREVIATIONS: Readonly<Record<string, string>> = {
  DTXZ: '低头旋转？',
  DTXXZ: '低头旋转？',
  TXZ: '头旋转？',
  TZZ: '头左右？',
  ZTXZ: '整体旋转？',
  ZTXZZ: '整体旋转？',
  TXZZ: '头旋转？',
  ZTX: '整体？',
  ZTY: '整体？',
  ZTYX: '整体左右？',
  ZTYY: '整体上下？',
  STY: '身体？',
  STYX: '身体左右？',
  STPYY: '身体上下？',
  STPYX: '身体左右？',
  SBXZ: '身体旋转？',
  SBSS: '身体伸缩？',
  SBQSQH: '身体？',
  YJL: '眼睛左右？',
  YJ: '眼睛？',
  YXK: '眼斜开？',
  YXK1X: '眼斜开1左右？',
  ZXK: '左眼斜开？',
  HGSD: '瞳孔竖动？',
  HGXS: '瞳孔伸缩？',
  HGCX: '瞳孔大小？',
  HKKS: '眼眶开闭？',
  HKCX: '眼眶大小？',
  HKXKS: '眼眶斜开？',
  HKXMX: '眼眶下面？',
  XKX: '下颚左右？',
  XKS: '下颚上下？',
  XCX: '下巴左右？',
  ZS1: '眨眼1？',
  ZS2: '眨眼2？',
  ZS3: '眨眼3？',
  ZS4: '眨眼4？',
  ZS3W: '眨眼3W？',
  ZS1FZ: '眨眼1翻转？',
  ZS1Y: '眨眼1左右？',
  ZKKS: '左眼眶开闭？',
  ZXTSS: '左眼特殊？',
  YXTSS: '右眼特殊？',
  TKKS: '瞳孔开闭？',
  TRKS: '瞳人开闭？',
  ZBKS: '嘴部开闭？',
  ZKK: '嘴开闭？',
  ZL: '皱纹？',
  ZLT: '皱纹T？',
  ZJ: '眨眼？',
  JCX: '脸颊左右？',
  JCXX: '脸颊形？',
  QBY: '嘴型？',
  QJY: '嘴角？',
  QJYD: '嘴角动？',
  QBWYX: '嘴变形左右？',
  QBWYY: '嘴变形上下？',
  MWJDWL: '嘴外侧？',
  MWYWL: '嘴下侧？',
  MUH: '嘴？',
  MRT: ' Mouth？',
  HYCX: '嘴唇大小？',
  HYJY: '嘴唇挤压？',
  HYSS: '嘴唇伸缩？',
  HYZTKS: '嘴唇整体开闭？',
  TFY: '头发？',
  HRS: '后发？',
  HS1: '头发1？',
  HH1X: '刘海1左右？',
  HHFW: '刘海翻转？',
  HHQQ: '刘海前后？',
  HG2CX: '后发2大小？',
  LKS: '鬓角？',
  LHXS: '刘海伸缩？',
  YYG: '衣领？',
  YCFX: '衣服方向？',
  YCFY: '衣服方向Y？',
  YBXZ: '衣摆旋转？',
  YQBXZ: '衣前摆旋转？',
  YDTXZ: '腰低头旋转？',
  YDTXZZ: '腰低头旋转？',
  YSXD: '胸口大小？',
  YSXDX: '胸口左右？',
  DAOX: '角度X？',
  DAOXZ: '角度旋转？',
  DAOY: '角度Y？',
  DL: '短？',
  DZ: '短针？',
  GGSD: '高光竖动？',
  GGXS: '高光伸缩？',
  SQ1: '视线1？',
  SQ2: '视线2？',
  XQJ: '下巴？',
  XBX: '胸部？',
  XBXZ: '胸部旋转？',
  XX: '胸？',
  XXZ: '胸针？',
  XY: '鞋？',
  YJY: '眼镜？',
  ZCFX: '姿态方向？',
  ZCFY: '姿态方向Y？',
  ZDTSS: '嘴的特殊？',
  ZQXZ: '嘴气旋转？',
  ZQXZ2: '嘴气旋转2？',
  ZZXD1: '左胸大1？',
  ZZXD2: '左胸大2？',
  ZZXD3: '左胸大3？',
  YZXD1: '右胸大1？',
  YZXD2: '右胸大2？',
  YZXD3: '右胸大3？',
  SDWL: '身的位移？',
  LANGUAGN: 'Language？',
}

/** Pinyin full-word ids (lowercase after Param) seen on bilibili rips. */
const PINYIN_WORDS: Readonly<Record<string, string>> = {
  jiaodu: '角度',
  daxiao: '大小',
  fanzhuan: '翻转',
  xuanzhuan: '旋转',
  yaobai: '摇摆',
  shangxia: '上下',
  zuoyou: '左右',
  xunhuan: '循环',
  toumingdu: '透明度',
  liangdu: '亮度',
  andu: '暗度',
  shanguang: '闪光',
  qianhou: '前后',
  bianxing: '变形',
  kaihe: '开合',
  yidong: '移动',
}

/** Removes the Param prefix and returns the abbreviation core, if any. */
function abbreviationCore(id: string): string | undefined {
  const match = /^(?:Param|PARAM)?_?([A-Za-z][A-Za-z0-9]*)$/u.exec(id)
  return match?.[1]
}

/** Strips a trailing digit suffix (SDWL2 → SDWL) for family lookup. */
function abbreviationBase(core: string): string {
  return core.replace(/[0-9]+$/u, '')
}

/** Guesses a Chinese label for an abbreviation id, or undefined. */
function guessAbbreviationLabel(id: string): string | undefined {
  const core = abbreviationCore(id)
  if (core === undefined) return undefined
  // Prefer the exact entry (ZS1 hits its own entry), then the digit-stripped
  // family key (SDWL2 falls back to SDWL).
  const exactUpper = core.toLocaleUpperCase()
  if (PINYIN_ABBREVIATIONS[exactUpper] !== undefined) return PINYIN_ABBREVIATIONS[exactUpper]
  const baseUpper = abbreviationBase(core).toLocaleUpperCase()
  if (baseUpper !== exactUpper && PINYIN_ABBREVIATIONS[baseUpper] !== undefined) {
    return PINYIN_ABBREVIATIONS[baseUpper]
  }
  if (PINYIN_WORDS[core.toLocaleLowerCase()] !== undefined) {
    return PINYIN_WORDS[core.toLocaleLowerCase()]
  }
  return undefined
}

/**
 * The id prefix that carries a known annotation: the exact abbreviation core
 * (ZS1 keeps its own 眨眼1 entry), else the digit-stripped family base
 * (SDWL2 folds into the SDWL family), else the plain leading word.
 */
function abbreviationLabelBase(id: string): string {
  const core = abbreviationCore(id)
  if (core === undefined) return leadingWord(id)
  const exactUpper = core.toLocaleUpperCase()
  const base = abbreviationBase(core)
  if (PINYIN_ABBREVIATIONS[exactUpper] !== undefined) return core
  if (base.toLocaleUpperCase() !== exactUpper && PINYIN_ABBREVIATIONS[base.toLocaleUpperCase()] !== undefined) {
    return base
  }
  if (PINYIN_WORDS[core.toLocaleLowerCase()] !== undefined) return core
  return leadingWord(id)
}

/**
 * Groups parameters into readable one-level categories: semantic keyword
 * groups first (sorted by group name), then a prefix-word fallback bucket
 * (pinyin abbreviations like DTXZ land there under their own prefix), and
 * finally everything unclassifiable under 其他. Group membership is stable
 * so the same parameter always appears in the same group.
 */
export function groupParameters(parameters: readonly Live2dParameterRange[]): readonly ParameterGroup[] {
  const matched = new Map<string, Live2dParameterRange[]>()
  const fallback = new Map<string, Live2dParameterRange[]>()
  const other: Live2dParameterRange[] = []

  for (const range of parameters) {
    const id = range.id.toLocaleLowerCase()
    let groupLabel: string | undefined
    for (const [keyword, label] of PARAMETER_GROUP_RULES) {
      if (id.includes(keyword)) {
        groupLabel = label
        break
      }
    }
    if (groupLabel !== undefined) {
      const bucket = matched.get(groupLabel) ?? []
      bucket.push(range)
      matched.set(groupLabel, bucket)
      continue
    }
    // Strip the common Param prefix and bucket by the leading word so
    // abbreviation families (SDWL, TKKS, ...) stay together. Known
    // abbreviations get their guessed Chinese meaning as the group label;
    // numbered ids with their own entry (ZS1) keep their exact name.
    const word = leadingWord(range.id)
    if (word.length >= 2 && word !== 'param') {
      const annotation = guessAbbreviationLabel(range.id)
      const label = annotation !== undefined
        ? `${abbreviationLabelBase(range.id).toLocaleUpperCase()}（${annotation}）`
        : word.toLocaleUpperCase()
      const bucket = fallback.get(label) ?? []
      bucket.push(range)
      fallback.set(label, bucket)
    }
    else {
      other.push(range)
    }
  }

  const groups: ParameterGroup[] = [...matched.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'))
    .map(([label, items]) => ({ label, items: sortById(items) }))
  for (const [label, items] of [...fallback.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ label, items: sortById(items) })
  }
  if (other.length > 0) groups.push({ label: '其他', items: sortById(other) })
  return groups
}

function sortById(items: readonly Live2dParameterRange[]): Live2dParameterRange[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id))
}

function line(text: string): HTMLElement {
  const div = document.createElement('div')
  div.textContent = text
  return div
}
