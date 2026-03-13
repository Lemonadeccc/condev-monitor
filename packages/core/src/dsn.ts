export interface ParsedDsn {
    appId: string
    origin: string
    basePath: string
}

/** Default HTTP header used to propagate trace IDs across browser ↔ server boundary. */
export const DEFAULT_TRACE_ID_HEADER = 'x-condev-trace-id'

/**
 * Parse a DSN URL into its components.
 *
 * Accepted formats:
 *   - `https://host/base/tracking/{appId}`  (canonical)
 *   - `https://host/base/{appId}`           (legacy / shorthand)
 */
export function parseDsn(dsn: string): ParsedDsn | null {
    try {
        const url = new URL(dsn)
        const parts = url.pathname.split('/').filter(Boolean)

        const trackingIndex = parts.indexOf('tracking')
        if (trackingIndex !== -1) {
            const appId = parts[trackingIndex + 1]
            if (!appId) return null
            const basePath = '/' + parts.slice(0, trackingIndex).join('/')
            return { appId, origin: url.origin, basePath }
        }

        if (parts.length < 2) return null
        const appId = parts[parts.length - 1]!
        const basePath = '/' + parts.slice(0, parts.length - 1).join('/')
        return { appId, origin: url.origin, basePath }
    } catch {
        return null
    }
}
