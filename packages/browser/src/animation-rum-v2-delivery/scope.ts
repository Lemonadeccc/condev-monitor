import type { AnimationRumV2DeliveryScope } from './types'

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u

export function createAnimationRumV2DeliveryScope(appId: string, trackingUrl: string): AnimationRumV2DeliveryScope {
    if (!APP_ID_PATTERN.test(appId)) throw new TypeError('Invalid Animation RUM v2 app id')
    if (trackingUrl !== trackingUrl.trim()) throw new TypeError('Invalid Animation RUM v2 tracking URL')

    let parsed: URL
    try {
        parsed = new URL(trackingUrl)
    } catch {
        throw new TypeError('Invalid Animation RUM v2 tracking URL')
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError('Animation RUM v2 tracking URL must use HTTP or HTTPS')
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new TypeError('Animation RUM v2 tracking URL must not contain credentials, query, or fragment')
    }

    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/u, '') : parsed.pathname
    const segments = pathname.split('/').filter(Boolean)
    if (segments.at(-1) !== appId || segments.at(-2) !== 'tracking') {
        throw new TypeError('Animation RUM v2 tracking URL does not match the app tracking route')
    }

    const canonicalTrackingUrl = `${parsed.origin}${pathname}`
    return {
        appId,
        trackingUrl: canonicalTrackingUrl,
        scopeKey: JSON.stringify([appId, canonicalTrackingUrl]),
    }
}
