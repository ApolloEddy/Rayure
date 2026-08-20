import { readFile } from 'node:fs/promises'

export interface PreparedLive2dMotion {
  id: string
  displayName: string
  group: string
  index: number
  file: string
}

const MAX_MODEL3_BYTES = 4 * 1024 * 1024

export async function readLive2dMotionCatalog(model3Path: string): Promise<readonly PreparedLive2dMotion[]> {
  const bytes = await readFile(model3Path)
  if (bytes.byteLength > MAX_MODEL3_BYTES) throw new Error('Live2D model3.json exceeds 4 MiB')

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    throw new Error('Live2D model3.json must contain valid JSON')
  }
  return parseLive2dMotionCatalog(parsed)
}

export function parseLive2dMotionCatalog(value: unknown): readonly PreparedLive2dMotion[] {
  const root = asRecord(value, 'Live2D model3.json')
  if (root.Version !== 3) throw new Error('Live2D model3.json Version must be 3')

  const references = asRecord(root.FileReferences, 'Live2D FileReferences')
  if (references.Motions === undefined) return []
  const groups = asRecord(references.Motions, 'Live2D FileReferences.Motions')
  const result: PreparedLive2dMotion[] = []
  const usedIds = new Set<string>()

  for (const [group, entries] of Object.entries(groups)) {
    requireDisplayString(group, 'Live2D motion group', 80)
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`Live2D motion group must be a non-empty array: ${group}`)
    }

    entries.forEach((entry, index) => {
      const motion = asRecord(entry, `Live2D motion ${group}[${index}]`)
      const file = parseMotionPath(motion.File, `Live2D motion ${group}[${index}].File`)
      parseOptionalDuration(motion.FadeInTime, `Live2D motion ${group}[${index}].FadeInTime`)
      parseOptionalDuration(motion.FadeOutTime, `Live2D motion ${group}[${index}].FadeOutTime`)

      const baseId = createMotionId(group, index)
      let id = baseId
      let suffix = 1
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`.slice(0, 64)
      usedIds.add(id)
      result.push({
        id,
        displayName: `${group} ${index + 1}`.slice(0, 96),
        group,
        index,
        file,
      })
    })
  }

  return result
}

function createMotionId(group: string, index: number): string {
  const slug = group
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `live2d-${slug || 'motion'}-${index}`.slice(0, 64)
}

function parseMotionPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 2048) {
    throw new Error(`${label} must be a trimmed relative motion3.json path`)
  }
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
    || !normalized.toLowerCase().endsWith('.motion3.json')
  ) {
    throw new Error(`${label} must be a relative .motion3.json path without traversal`)
  }
  return normalized
}

function parseOptionalDuration(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60) {
    throw new Error(`${label} must be a finite duration between 0 and 60 seconds`)
  }
  return value
}

function requireDisplayString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${label} must be a trimmed printable string up to ${maxLength} characters`)
  }
  return value
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
