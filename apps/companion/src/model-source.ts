export interface CompanionModelSource {
  id: string
  displayName: string
  format: 'pmx' | 'live2d'
  entryFilePath: string
  /** Live2D parts that belong to the source scene/effects, not the character skin. */
  skinHiddenPartIds?: readonly string[]
  /** Writable local-state file for calibration; deliberately outside the model asset tree. */
  calibrationFilePath?: string
}

export interface CompanionMotionSource {
  id: string
  displayName: string
  format: 'vmd'
  entryFilePath: string
  loop?: boolean
}
