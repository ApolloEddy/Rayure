export interface WallpaperUserProperty {
  value: unknown
}

export interface WallpaperUserProperties {
  companionport?: WallpaperUserProperty
  accentcolor?: WallpaperUserProperty
  modelscale?: WallpaperUserProperty
  showstatus?: WallpaperUserProperty
}

export interface WallpaperGeneralProperties {
  fps?: unknown
}

export interface WallpaperPropertyListener {
  applyUserProperties?(properties: WallpaperUserProperties): void
  applyGeneralProperties?(properties: WallpaperGeneralProperties): void
  setPaused?(isPaused: boolean): void
}

declare global {
  interface Window {
    wallpaperPropertyListener?: WallpaperPropertyListener
  }
}
