import {
  STANDARD_LIVE2D_RIG_PROFILE,
} from './rig-profile.ts'
import type {
  Live2dRigProfile,
} from './rig-profile.ts'

export interface Live2dMotionReference {
  file: string
  fadeInTime?: number
  fadeOutTime?: number
}

export interface Live2dModelFileReferences {
  moc: string
  textures: readonly string[]
  physics?: string
  pose?: string
  userData?: string
  displayInfo?: string
  motions: Readonly<Record<string, readonly Live2dMotionReference[]>>
}

export interface Live2dModelGroup {
  target: string
  name: string
  ids: readonly string[]
}

export interface Live2dHitArea {
  id: string
  name: string
}

export interface Live2dModelManifest {
  id: string
  version: 3
  fileReferences: Live2dModelFileReferences
  groups: readonly Live2dModelGroup[]
  hitAreas: readonly Live2dHitArea[]
}

export interface Live2dParameterDefinition {
  id: string
  groupId?: string
  name?: string
}

export interface Live2dParameterScan {
  profileId: string
  requiredParameterIds: readonly string[]
  matchedParameterIds: readonly string[]
  missingParameterIds: readonly string[]
  availableParameterCount: number
}

export function parseLive2dModel3(value: unknown, id?: string): Live2dModelManifest {
  const root = asRecord(value, 'Live2D model3.json')
  if (root.Version !== 3) throw new Error('Live2D model3.json Version must be 3')

  const references = asRecord(root.FileReferences, 'Live2D FileReferences')
  const moc = parseAssetPath(references.Moc, 'FileReferences.Moc', ['.moc3'])
  const textures = parseAssetPaths(references.Textures, 'FileReferences.Textures', ['.png'])
  const physics = parseOptionalAssetPath(references.Physics, 'FileReferences.Physics', ['.json'])
  const pose = parseOptionalAssetPath(references.Pose, 'FileReferences.Pose', ['.json'])
  const userData = parseOptionalAssetPath(references.UserData, 'FileReferences.UserData', ['.json'])
  const displayInfo = parseOptionalAssetPath(references.DisplayInfo, 'FileReferences.DisplayInfo', ['.json'])
  const motions = parseMotions(references.Motions)

  return {
    id: id ?? fileStem(moc),
    version: 3,
    fileReferences: {
      moc,
      textures,
      ...(physics === undefined ? {} : { physics }),
      ...(pose === undefined ? {} : { pose }),
      ...(userData === undefined ? {} : { userData }),
      ...(displayInfo === undefined ? {} : { displayInfo }),
      motions,
    },
    groups: parseGroups(root.Groups),
    hitAreas: parseHitAreas(root.HitAreas),
  }
}

export function parseLive2dDisplayInfo(value: unknown): readonly Live2dParameterDefinition[] {
  const root = asRecord(value, 'Live2D cdi3.json')
  if (root.Version !== 3) throw new Error('Live2D cdi3.json Version must be 3')
  if (!Array.isArray(root.Parameters) || root.Parameters.length === 0) {
    throw new Error('Live2D cdi3.json must define at least one parameter')
  }

  const seen = new Set<string>()
  return root.Parameters.map((value, index) => {
    const parameter = asRecord(value, `Live2D cdi3 parameter ${index}`)
    const parameterId = parseIdentifier(parameter.Id, `Live2D cdi3 parameter ${index} id`)
    if (seen.has(parameterId)) throw new Error(`Duplicate Live2D cdi3 parameter id: ${parameterId}`)
    seen.add(parameterId)
    const groupId = parameter.GroupId === undefined
      ? undefined
      : parseIdentifier(parameter.GroupId, `Live2D cdi3 parameter ${parameterId} group id`)
    const name = parameter.Name === undefined
      ? undefined
      : parseIdentifier(parameter.Name, `Live2D cdi3 parameter ${parameterId} name`)
    return {
      id: parameterId,
      ...(groupId === undefined ? {} : { groupId }),
      ...(name === undefined ? {} : { name }),
    }
  })
}

export function scanLive2dRigProfile(
  parameters: readonly Live2dParameterDefinition[],
  profile: Live2dRigProfile = STANDARD_LIVE2D_RIG_PROFILE,
): Live2dParameterScan {
  const available = new Set(parameters.map(parameter => parameter.id))
  const requiredParameterIds = profile.parameters.map(binding => binding.parameterId)
  const matchedParameterIds = requiredParameterIds.filter(parameterId => available.has(parameterId))
  return {
    profileId: profile.id,
    requiredParameterIds,
    matchedParameterIds,
    missingParameterIds: requiredParameterIds.filter(parameterId => !available.has(parameterId)),
    availableParameterCount: available.size,
  }
}

export function collectLive2dAssetPaths(manifest: Live2dModelManifest): readonly string[] {
  const paths = [
    manifest.fileReferences.moc,
    ...manifest.fileReferences.textures,
    manifest.fileReferences.physics,
    manifest.fileReferences.pose,
    manifest.fileReferences.userData,
    manifest.fileReferences.displayInfo,
    ...Object.values(manifest.fileReferences.motions).flat().map(motion => motion.file),
  ]
  return [...new Set(paths.filter((path): path is string => path !== undefined))].sort()
}

export function hasLive2dMoc3Header(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x4f
    && bytes[2] === 0x43
    && bytes[3] === 0x33
}

function parseMotions(value: unknown): Readonly<Record<string, readonly Live2dMotionReference[]>> {
  if (value === undefined) return {}
  const groups = asRecord(value, 'Live2D FileReferences.Motions')
  const result: Record<string, readonly Live2dMotionReference[]> = {}
  for (const [groupName, entries] of Object.entries(groups)) {
    const group = Array.isArray(entries) ? entries : undefined
    if (!group || group.length === 0) throw new Error(`Live2D motion group must be a non-empty array: ${groupName}`)
    result[groupName] = group.map((entry, index) => {
      const motion = asRecord(entry, `Live2D motion ${groupName}[${index}]`)
      const parsed: Live2dMotionReference = {
        file: parseAssetPath(motion.File, `Live2D motion ${groupName}[${index}].File`, ['.motion3.json']),
      }
      const fadeInTime = parseOptionalDuration(motion.FadeInTime, `Live2D motion ${groupName}[${index}].FadeInTime`)
      const fadeOutTime = parseOptionalDuration(motion.FadeOutTime, `Live2D motion ${groupName}[${index}].FadeOutTime`)
      return {
        ...parsed,
        ...(fadeInTime === undefined ? {} : { fadeInTime }),
        ...(fadeOutTime === undefined ? {} : { fadeOutTime }),
      }
    })
  }
  return result
}

function parseGroups(value: unknown): readonly Live2dModelGroup[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Live2D Groups must be an array')
  return value.map((entry, index) => {
    const group = asRecord(entry, `Live2D group ${index}`)
    const target = parseIdentifier(group.Target, `Live2D group ${index} target`)
    const name = parseIdentifier(group.Name, `Live2D group ${index} name`)
    const ids = parseIdentifiers(group.Ids, `Live2D group ${index} ids`)
    return { target, name, ids }
  })
}

function parseHitAreas(value: unknown): readonly Live2dHitArea[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Live2D HitAreas must be an array')
  return value.map((entry, index) => {
    const hitArea = asRecord(entry, `Live2D hit area ${index}`)
    return {
      id: parseIdentifier(hitArea.Id, `Live2D hit area ${index} id`),
      name: parseIdentifier(hitArea.Name, `Live2D hit area ${index} name`),
    }
  })
}

function parseAssetPaths(value: unknown, label: string, extensions: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const paths = value.map((entry, index) => parseAssetPath(entry, `${label}[${index}]`, extensions))
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains duplicate paths`)
  return paths
}

function parseOptionalAssetPath(value: unknown, label: string, extensions: readonly string[]): string | undefined {
  return value === undefined ? undefined : parseAssetPath(value, label, extensions)
}

function parseAssetPath(value: unknown, label: string, extensions: readonly string[]): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a trimmed non-empty string`)
  }
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a relative asset path without traversal`)
  }
  if (!extensions.some(extension => normalized.toLowerCase().endsWith(extension))) {
    throw new Error(`${label} must end with ${extensions.join(' or ')}`)
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

function parseIdentifiers(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const identifiers = value.map((entry, index) => parseIdentifier(entry, `${label}[${index}]`))
  if (new Set(identifiers).size !== identifiers.length) throw new Error(`${label} contains duplicate identifiers`)
  return identifiers
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a trimmed non-empty string up to 256 characters`)
  }
  return value
}

function fileStem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.moc3$/iu, '') || 'live2d-model'
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
