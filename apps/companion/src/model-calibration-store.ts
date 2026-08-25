import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { CompanionModelSource } from './model-source.ts'

export interface ModelCalibrationStoreOptions {
  /** Test/embedding override. Production uses the per-user Rayure state root. */
  stateRoot?: string | undefined
}

/**
 * Returns the writable per-user state root used for generated Rayure metadata.
 * Character/model directories remain read-only; calibration never belongs next
 * to a purchased or otherwise private model asset.
 */
export function resolveRayureStateRoot(options: ModelCalibrationStoreOptions = {}): string {
  if (options.stateRoot !== undefined) {
    if (!isAbsolute(options.stateRoot)) throw new Error('Rayure state root must be an absolute path')
    return resolve(options.stateRoot)
  }

  const localAppData = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && localAppData !== undefined && isAbsolute(localAppData)) {
    return resolve(localAppData, 'Rayure')
  }
  return resolve(homedir(), '.rayure')
}

/**
 * Produces a stable, non-revealing filename for one canonical Live2D source.
 * The model id stays readable while the path itself is represented only by a
 * short SHA-256 digest so local paths do not leak through directory listings.
 */
export function resolveModelCalibrationFilePath(
  model: Pick<CompanionModelSource, 'id' | 'format' | 'entryFilePath'>,
  options: ModelCalibrationStoreOptions = {},
): string | undefined {
  if (model.format !== 'live2d') return undefined
  const canonicalPath = process.platform === 'win32'
    ? model.entryFilePath.toLocaleLowerCase('en-US')
    : model.entryFilePath
  const digest = createHash('sha256')
    .update(`live2d\0${canonicalPath}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
  return join(resolveRayureStateRoot(options), 'calibrations', `${model.id}-${digest}.json`)
}
