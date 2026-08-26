import { getBrowserInfo } from '@condev-monitor/monitor-sdk-browser-utils'
import { getUser, parseDsn } from '@condev-monitor/monitor-sdk-core'

import type { EventCategory, EventPriority, ReportEnvelope } from './types'

export { parseDsn }
export type { ParsedDsn } from '@condev-monitor/monitor-sdk-core'

// ---- Unique ID generation ----

function generateEventId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

const SAFE_ANIMATION_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/

function selectAnimationVersion(contextValue: string | undefined, payloadValue: unknown): unknown {
    if (contextValue === '' || (typeof contextValue === 'string' && SAFE_ANIMATION_VERSION_RE.test(contextValue))) {
        return contextValue
    }
    return payloadValue
}

/**
 * Generic tracking has historically accepted arbitrary event names. Only a
 * version-marked `animation_rum` payload belongs to the closed v1 protocol;
 * an older custom event with the same name must keep the legacy enrichment,
 * identifier, and queue-category behavior.
 */
function isAnimationRumV1Candidate(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).event_type === 'animation_rum' &&
        ('contractVersion' in value || 'snapshotSchemaVersion' in value)
    )
}

// ---- Category / priority inference ----

function inferCategory(eventType: unknown, detailType?: unknown): EventCategory {
    if (typeof eventType !== 'string') return 'custom'
    const normalizedEventType = eventType.toLowerCase()
    const normalizedDetailType = typeof detailType === 'string' ? detailType.toLowerCase() : ''

    if (normalizedEventType === 'error' || normalizedEventType === 'whitescreen' || normalizedEventType === 'white_screen') return 'error'
    if (normalizedEventType === 'ai_streaming') return 'ai_streaming'
    if (normalizedEventType.includes('vital') || normalizedEventType.includes('metric') || normalizedDetailType === 'webvital')
        return 'webvital'
    if (
        normalizedEventType === 'performance' ||
        normalizedEventType === 'longtask' ||
        normalizedEventType === 'jank' ||
        normalizedEventType === 'fps' ||
        normalizedEventType === 'lowfps' ||
        normalizedDetailType === 'longtask' ||
        normalizedDetailType === 'jank' ||
        normalizedDetailType === 'fps' ||
        normalizedDetailType === 'lowfps'
    )
        return 'performance'
    return 'custom'
}

function inferPriority(category: EventCategory): EventPriority {
    return category === 'error' ? 'immediate' : 'batch'
}

// ---- Payload enrichment ----

export function enrichPayload(data: Record<string, unknown>, context?: { release?: string; dist?: string }): Record<string, unknown> {
    if (isAnimationRumV1Candidate(data)) {
        // Animation RUM has a closed, privacy-reviewed wire schema. Do not add
        // the identity/browser fields used by legacy telemetry payloads.
        const {
            browserInfo: _browserInfo,
            userId: _userId,
            userEmail: _userEmail,
            referrer: _referrer,
            userAgent: _userAgent,
            ua: _ua,
            path: _path,
            ...privacySafeData
        } = data
        return {
            ...privacySafeData,
            release: selectAnimationVersion(context?.release, privacySafeData.release),
            dist: selectAnimationVersion(context?.dist, privacySafeData.dist),
        }
    }

    const browserInfo = getBrowserInfo()
    const rawMessage = data['message']
    const message = typeof rawMessage === 'string' ? rawMessage : ''
    const user = getUser()

    return {
        ...data,
        message,
        browserInfo,
        release: context?.release,
        dist: context?.dist,
        ...(user && { userId: user.id, userEmail: user.email }),
    }
}

// ---- Envelope creation ----

export function createEnvelope(enrichedPayload: Record<string, unknown>, appId: string): ReportEnvelope {
    const animationRumV1 = isAnimationRumV1Candidate(enrichedPayload)
    const category = animationRumV1 ? 'performance' : inferCategory(enrichedPayload.event_type, enrichedPayload.type)
    const priority = inferPriority(category)
    const payloadEventId = enrichedPayload.eventId
    const eventId =
        animationRumV1 && typeof payloadEventId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(payloadEventId)
            ? payloadEventId
            : generateEventId()

    return {
        eventId,
        appId,
        clientCreatedAt: Date.now(),
        category,
        priority,
        payload: enrichedPayload,
        retryCount: 0,
    }
}
