export const DEFAULT_LIVE2D_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

const MAX_CORE_URL_LENGTH = 2048

/**
 * Resolve an explicitly requested Cubism Core source without allowing the
 * debug query string to become an arbitrary remote script loader.
 *
 * `undefined` means "use the built-in official default". Relative paths are
 * resolved against the current wallpaper origin so `/@fs/...` works only in
 * the local Vite debug server and never becomes a bundled asset.
 */
export function resolveLive2dCoreUrl(
  value: string | null | undefined,
  baseUrl: string,
): string | undefined {
  if (value === null || value === undefined) return undefined
  if (
    value.length < 1
    || value.length > MAX_CORE_URL_LENGTH
    || value.trim() !== value
    || value.includes('\\')
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) return undefined

  let parsed: URL
  let base: URL
  try {
    base = new URL(baseUrl)
    parsed = new URL(value, base)
  }
  catch {
    return undefined
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
  if (parsed.protocol === 'https:' && parsed.href === DEFAULT_LIVE2D_CORE_URL) return parsed.href
  if (!isJavaScriptPath(parsed.pathname)) return undefined

  const sameOrigin = parsed.origin === base.origin
  const loopback = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
  if (!sameOrigin && !loopback) return undefined
  return parsed.href
}

function isJavaScriptPath(pathname: string): boolean {
  return pathname.toLowerCase().endsWith('.js')
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}
