export interface CompanionModelSource {
  id: string
  displayName: string
  format: 'pmx' | 'live2d'
  entryFilePath: string
}

export interface CompanionMotionSource {
  id: string
  displayName: string
  format: 'vmd'
  entryFilePath: string
  loop?: boolean
}
