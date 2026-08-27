import {
  MOTION_DEBUG_ALL_PRESETS,
  MOTION_DEBUG_MODELS,
  MOTION_DEBUG_PRESETS,
} from './motion-debug-presets.ts'
import type { MotionDebugModelChoice, MotionDebugPreset } from './motion-debug-presets.ts'

export interface MotionDebugPanelCallbacks {
  onStartPreset?: (preset: MotionDebugPreset) => void
  onInterrupt?: () => void
  onAbort?: () => void
  onLoopChange?: (enabled: boolean) => void
  onAutoIdleChange?: (enabled: boolean) => void
  onModelChange?: (choice: MotionDebugModelChoice | { file: File }) => void
}

/**
 * Left-docked control surface for the ARDY 3D debug workbench.  Owns no logic —
 * every action bubbles to the caller through callbacks so main.ts keeps the
 * Companion + surface wiring.  Collapsible so it never has to cover the rig.
 */
export class MotionDebugPanel {
  readonly root: HTMLElement
  readonly #status: HTMLElement
  readonly #presetSelect: HTMLSelectElement
  readonly #modelSelect: HTMLSelectElement
  readonly #fileInput: HTMLInputElement
  readonly #startButton: HTMLButtonElement
  readonly #loopCheckbox: HTMLInputElement
  readonly #autoIdleCheckbox: HTMLInputElement
  #collapsed = false

  constructor(callbacks: MotionDebugPanelCallbacks) {
    const root = document.createElement('aside')
    root.className = 'motion-debug-panel'
    root.setAttribute('aria-label', 'ARDY 3D 调试台')

    const header = document.createElement('header')
    header.className = 'motion-debug-panel-header'
    const title = document.createElement('strong')
    title.textContent = 'ARDY 3D 调试台'
    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'motion-debug-panel-collapse'
    collapse.textContent = '—'
    collapse.title = '折叠/展开调试台'
    collapse.addEventListener('click', () => {
      this.#collapsed = !this.#collapsed
      root.classList.toggle('collapsed', this.#collapsed)
      collapse.textContent = this.#collapsed ? '+' : '—'
    })
    header.append(title, collapse)

    const body = document.createElement('div')
    body.className = 'motion-debug-panel-body'

    // 模型选择：内置 CoreSkin/夹具 PMX + 本地文件上传。
    const modelLabel = document.createElement('span')
    modelLabel.className = 'motion-debug-panel-label'
    modelLabel.textContent = '模型'
    const modelRow = document.createElement('div')
    modelRow.className = 'motion-debug-panel-row'
    this.#modelSelect = document.createElement('select')
    this.#modelSelect.className = 'motion-debug-panel-select'
    for (const choice of MOTION_DEBUG_MODELS) {
      const option = document.createElement('option')
      option.value = choice.id
      option.textContent = choice.label
      this.#modelSelect.append(option)
    }
    this.#modelSelect.addEventListener('change', () => {
      const choice = MOTION_DEBUG_MODELS.find(item => item.id === this.#modelSelect.value)
      if (choice !== undefined) callbacks.onModelChange?.(choice)
    })
    const fileButton = document.createElement('button')
    fileButton.type = 'button'
    fileButton.textContent = '本地 PMX…'
    fileButton.title = '选择本机 .pmx 模型加载'
    this.#fileInput = document.createElement('input')
    this.#fileInput.type = 'file'
    this.#fileInput.accept = '.pmx,application/octet-stream'
    this.#fileInput.hidden = true
    this.#fileInput.addEventListener('change', () => {
      const file = this.#fileInput.files?.[0]
      if (file !== undefined) callbacks.onModelChange?.({ file })
      this.#fileInput.value = ''
    })
    fileButton.addEventListener('click', () => this.#fileInput.click())
    // The input must be attached for programmatic tooling and a11y to see it;
    // `hidden` keeps it invisible while the styled button owns the interaction.
    modelRow.append(this.#modelSelect, fileButton, this.#fileInput)

    // 预设：LLM2Vec 语义生成 + 本地夹具直放。
    const presetLabel = document.createElement('span')
    presetLabel.className = 'motion-debug-panel-label'
    presetLabel.textContent = '预设（LLM2Vec 语义 / 夹具）'
    this.#presetSelect = document.createElement('select')
    this.#presetSelect.className = 'motion-debug-panel-select'
    const semanticGroup = document.createElement('optgroup')
    semanticGroup.label = 'LLM2Vec 语义生成（需 Companion）'
    for (const preset of MOTION_DEBUG_PRESETS) {
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = preset.label
      semanticGroup.append(option)
    }
    this.#presetSelect.append(semanticGroup)
    const fixtureGroup = document.createElement('optgroup')
    fixtureGroup.label = '本地夹具直放（无需 Companion）'
    for (const preset of MOTION_DEBUG_ALL_PRESETS) {
      if (preset.fixtureUrl === undefined) continue
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = preset.label
      fixtureGroup.append(option)
    }
    if (fixtureGroup.children.length > 0) this.#presetSelect.append(fixtureGroup)

    const startRow = document.createElement('div')
    startRow.className = 'motion-debug-panel-row'
    this.#startButton = document.createElement('button')
    this.#startButton.type = 'button'
    this.#startButton.className = 'motion-debug-panel-primary'
    this.#startButton.textContent = '确定 · 开始'
    this.#startButton.addEventListener('click', () => {
      const preset = MOTION_DEBUG_ALL_PRESETS.find(item => item.id === this.#presetSelect.value)
      if (preset !== undefined) callbacks.onStartPreset?.(preset)
    })
    startRow.append(this.#startButton)

    const playRow = document.createElement('div')
    playRow.className = 'motion-debug-panel-row'
    const interrupt = document.createElement('button')
    interrupt.type = 'button'
    interrupt.textContent = '中断'
    interrupt.title = '立即停止当前动作'
    interrupt.addEventListener('click', () => callbacks.onInterrupt?.())
    const abort = document.createElement('button')
    abort.type = 'button'
    abort.textContent = '中止'
    abort.title = '停止动作并放弃正在生成的 ARDY 请求'
    abort.addEventListener('click', () => callbacks.onAbort?.())
    playRow.append(interrupt, abort)

    const optionRow = document.createElement('div')
    optionRow.className = 'motion-debug-panel-row'
    this.#loopCheckbox = document.createElement('input')
    this.#loopCheckbox.type = 'checkbox'
    this.#loopCheckbox.id = 'mdp-loop'
    const loopLabel = document.createElement('label')
    loopLabel.textContent = '循环播放'
    loopLabel.htmlFor = 'mdp-loop'
    this.#loopCheckbox.addEventListener('change', () => callbacks.onLoopChange?.(this.#loopCheckbox.checked))
    this.#autoIdleCheckbox = document.createElement('input')
    this.#autoIdleCheckbox.type = 'checkbox'
    this.#autoIdleCheckbox.id = 'mdp-auto-idle'
    this.#autoIdleCheckbox.checked = true
    const autoIdleLabel = document.createElement('label')
    autoIdleLabel.textContent = '播完回静止'
    autoIdleLabel.htmlFor = 'mdp-auto-idle'
    this.#autoIdleCheckbox.addEventListener('change', () => callbacks.onAutoIdleChange?.(this.#autoIdleCheckbox.checked))
    optionRow.append(loopLabel, this.#loopCheckbox, autoIdleLabel, this.#autoIdleCheckbox)

    this.#status = document.createElement('code')
    this.#status.className = 'motion-debug-panel-status'
    this.#status.textContent = 'ready · 选择预设后点“确定”'

    body.append(
      modelLabel,
      modelRow,
      presetLabel,
      this.#presetSelect,
      startRow,
      playRow,
      optionRow,
      this.#status,
    )
    root.append(header, body)
    document.body.append(root)
    this.root = root
  }

  setStatus(text: string): void {
    this.#status.textContent = text
  }

  setStartEnabled(enabled: boolean): void {
    this.#startButton.disabled = !enabled
  }

  setLoopChecked(enabled: boolean): void {
    this.#loopCheckbox.checked = enabled
  }

  get autoIdleEnabled(): boolean {
    return this.#autoIdleCheckbox.checked
  }
}
