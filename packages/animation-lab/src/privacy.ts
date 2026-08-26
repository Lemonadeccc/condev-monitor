const SENSITIVE_SEGMENT = /^(?:\d{5,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[^/@\s]+@[^/\s]+)$/iu

function redactPath(pathname: string): string {
    const normalized = pathname.replace(/\\/gu, '/')
    const inputSegments = normalized.split('/')
    const homeRoot = inputSegments.findIndex(segment => /^(?:users|home)$/iu.test(segment))
    const segments = inputSegments.map((segment, index) => {
        const privateHomeSegment = homeRoot >= 0 && index === homeRoot + 1
        return privateHomeSegment || SENSITIVE_SEGMENT.test(decodeURIComponentSafe(segment)) ? ':redacted' : segment.slice(0, 120)
    })
    const nonEmpty = segments.filter(Boolean)
    const retained = nonEmpty.slice(-8)
    const prefix = nonEmpty.length > retained.length ? '…/' : normalized.startsWith('/') ? '/' : ''
    return `${prefix}${retained.join('/')}`.slice(0, 512)
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

/** Sanitizes a trace source without retaining credentials, query, hash, or origin. */
export function sanitizeTraceSource(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return ''
    const trimmed = value.trim().slice(0, 2_048)
    if (/^(?:blob:|data:)/iu.test(trimmed)) return `${trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()}[redacted]`
    if (/^about:/iu.test(trimmed)) return trimmed.toLowerCase() === 'about:blank' ? 'about:blank' : 'about:[redacted]'
    if (/^node:/iu.test(trimmed)) return /^node:[A-Za-z0-9_./-]{1,120}$/u.test(trimmed) ? trimmed : 'node:[redacted]'
    if (/^(?:webpack|vite):/iu.test(trimmed)) {
        return redactPath(trimmed.replace(/^[a-z]+:(?:\/\/)?/iu, '').split(/[?#]/u, 1)[0]!)
    }
    try {
        const parsed = new URL(trimmed)
        return redactPath(parsed.pathname || '/')
    } catch {
        const withoutQuery = trimmed.split('#', 1)[0]!.split('?', 1)[0]!
        return redactPath(withoutQuery)
    }
}

export function safeToken(value: unknown, fallback: string, max = 120): string {
    if (typeof value !== 'string') return fallback
    const normalized = value.trim()
    return /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u.test(normalized) ? normalized.slice(0, max) : fallback
}

export function safeDisplayText(value: unknown, fallback = '', max = 180): string {
    if (typeof value !== 'string') return fallback
    // eslint-disable-next-line no-control-regex -- collapse every C0/DEL run before retaining bounded display text.
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    return normalized.trim().slice(0, max)
}
