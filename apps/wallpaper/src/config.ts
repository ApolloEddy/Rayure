export interface AccentColor {
  r: number
  g: number
  b: number
}

export interface WallpaperSettings {
  companionPort: number
  fps: number
  accent: AccentColor
  modelScale: number
  showStatus: boolean
  showBranding: boolean
  importNativeContent: boolean
}

export const DEFAULT_WALLPAPER_SETTINGS: Readonly<WallpaperSettings> = {
  companionPort: 32145,
  fps: 30,
  accent: { r: 103, g: 232, b: 249 },
  modelScale: 1,
  showStatus: false,
  showBranding: false,
  importNativeContent: false,
}

export function parsePort(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^[0-9]{4,5}$/u.test(value)) return undefined
    value = Number(value)
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65_535) {
    return undefined
  }
  return value
}

export function parseFps(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 240) {
    return undefined
  }
  return value
}

export function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function parseModelScale(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 25 || value > 200) {
    return undefined
  }
  return value / 100
}

export function parseAccentColor(value: unknown): AccentColor | undefined {
  if (typeof value !== 'string' || value.trim() !== value) return undefined
  const parts = value.split(' ')
  if (parts.length !== 3 || parts.some(part => part.length === 0)) return undefined
  const channels = parts.map(part => Number(part))
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) return undefined
  const [r, g, b] = channels
  if (r === undefined || g === undefined || b === undefined) return undefined
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  }
}

export function toCssColor(color: AccentColor, alpha = 1): string {
  const safeAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${safeAlpha})`
}
