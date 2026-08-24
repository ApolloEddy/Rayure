export interface Live2dExpressionModelLike {
  setExpression(expression: string): void
  stopExpressions(): void
  getExpressions?(): readonly string[]
}

/**
 * Resolves a Companion semantic expression name to the expression identifier
 * used by Cubism. Model3 manifests usually expose a file name (for example
 * `expressions/smile.exp3.json`), while callers naturally send `smile`.
 */
export function resolveLive2dExpression(
  requestedName: string,
  availableExpressions: readonly string[],
): string | undefined {
  const requested = requestedName.trim()
  if (requested.length === 0) return undefined

  const exact = availableExpressions.find(expression => expression === requested)
  if (exact !== undefined) return exact

  const requestedKey = normalizeLive2dExpressionKey(requested)
  if (requestedKey.length === 0) return undefined
  const requestedKeys = expressionKeyVariants(requested)

  const normalized = availableExpressions.find(expression => {
    const variants = expressionKeyVariants(expression)
    return requestedKeys.some(key => variants.includes(key))
  })
  if (normalized !== undefined) return normalized

  const semanticKeys = requestedKeys.flatMap(key => resolveSemanticExpressionKeys(key))
  if (semanticKeys.length === 0) return undefined
  return availableExpressions.find(expression => {
    const variants = expressionKeyVariants(expression)
    return semanticKeys.some(key => variants.includes(key))
  })
}

export function normalizeLive2dExpressionKey(value: string): string {
  const basename = value
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .at(-1) ?? ''
  return basename
    .replace(/(?:\.exp3)?\.json$/iu, '')
    .replace(/\.exp3$/iu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '')
}

/**
 * The renderer owns Cubism's expression fade curves. The protocol weight is
 * therefore an activation gate here: zero resets, any positive valid weight
 * starts the native expression and lets its exp3 asset control blending.
 */
export class Live2dExpressionController {
  #model: Live2dExpressionModelLike | undefined
  #activeExpressionId: string | undefined
  #disposed = false

  get activeExpressionId(): string | undefined {
    return this.#activeExpressionId
  }

  bindModel(model: Live2dExpressionModelLike | undefined): void {
    if (this.#disposed) return
    this.#activeExpressionId = undefined
    this.#model = model
  }

  setExpression(name: string, weight: number, _durationMs?: number): boolean {
    if (
      this.#disposed
      || !this.#model
      || !Number.isFinite(weight)
      || weight < 0
      || weight > 1
    ) return false
    if (weight === 0) return this.reset()

    const available = this.#model.getExpressions?.()
    const expression = available === undefined
      ? name.trim()
      : resolveLive2dExpression(name, available)
    if (!expression) return false

    try {
      this.#model.setExpression(expression)
      this.#activeExpressionId = expression
      return true
    }
    catch {
      return false
    }
  }

  reset(_durationMs?: number): boolean {
    if (this.#disposed || !this.#model) return false
    try {
      this.#model.stopExpressions()
      this.#activeExpressionId = undefined
      return true
    }
    catch {
      return false
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#activeExpressionId = undefined
    this.#model = undefined
  }
}

const SEMANTIC_EXPRESSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  angry: ['angry', 'mad', 'rage', '生气', '愤怒', '怒'],
  blink: ['blink', 'eyeclose', 'closeeyes', '闭眼', '闭目'],
  blush: ['blush', 'shy', '脸红', '害羞'],
  cry: ['cry', 'tears', '泪', '哭', '流泪'],
  happy: ['happy', 'happiness', 'joy', 'smile', '微笑', '笑脸', '笑顔', '开心'],
  neutral: ['neutral', 'normal', 'default', '普通', '默认'],
  pout: ['pout', 'tsun', '撅嘴', '嘟嘴'],
  sad: ['sad', 'sorrow', '悲伤', '难过', '悲しい'],
  surprised: ['surprise', 'surprised', '惊讶', '吃惊', '惊き'],
  wink: ['wink', '眨眼', '单眨', '片目'],
}

function expressionKeyVariants(value: string): readonly string[] {
  const key = normalizeLive2dExpressionKey(value)
  if (key.length === 0) return []
  const variants = [key]
  for (const prefix of ['expression', 'expressions', 'exp']) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      variants.push(key.slice(prefix.length))
    }
  }
  return variants
}

function resolveSemanticExpressionKeys(requestedKey: string): readonly string[] {
  for (const [semanticKey, aliases] of Object.entries(SEMANTIC_EXPRESSION_ALIASES)) {
    const normalizedAliases = [semanticKey, ...aliases].flatMap(alias => expressionKeyVariants(alias))
    if (normalizedAliases.includes(requestedKey)) return normalizedAliases
  }
  return []
}
