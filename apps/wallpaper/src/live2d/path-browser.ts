function normalize(value: string): string {
  if (isUrl(value)) return value.replaceAll('\\', '/')
  return value.replaceAll('\\', '/').replace(/\/+/gu, '/')
}

export function extname(value: string): string {
  const normalized = isUrl(value) ? new URL(value).pathname : normalize(value)
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

export function dirname(value: string): string {
  if (isUrl(value)) {
    const url = new URL(value)
    const separator = url.pathname.lastIndexOf('/')
    url.pathname = separator < 0 ? '/' : url.pathname.slice(0, separator) || '/'
    url.search = ''
    url.hash = ''
    return url.href.replace(/\/$/u, '')
  }
  const normalized = normalize(value)
  const separator = normalized.lastIndexOf('/')
  return separator <= 0 ? (separator === 0 ? '/' : '.') : normalized.slice(0, separator)
}

export function join(...parts: readonly string[]): string {
  const first = parts[0]
  if (first !== undefined && isUrl(first)) {
    const base = first.endsWith('/') ? first : `${first}/`
    return new URL(parts.slice(1).filter(part => part.length > 0).join('/'), base).href
  }
  const joined = normalize(parts.filter(part => part.length > 0).join('/'))
  return joined.replace(/^(\.\/)+/u, '') || '.'
}

function isUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)
}

export default { dirname, extname, join }
