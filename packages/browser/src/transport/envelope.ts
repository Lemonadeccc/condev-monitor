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

// ---- Category / priority inference ----

function inferCategory(eventType: unknown): EventCategory {
    if (typeof eventType !== 'string') return 'custom'
    if (eventType === 'error' || eventType === 'whitescreen' || eventType === 'white_screen') return 'error'
    if (eventType === 'ai_streaming') return 'ai_streaming'
    if (eventType.includes('vital') || eventType.includes('metric')) return 'webvital'
    if (eventType === 'longtask' || eventType === 'jank' || eventType === 'fps') return 'performance'
    return 'custom'
}

function inferPriority(category: EventCategory): EventPriority {
    return category === 'error' ? 'immediate' : 'batch'
}

// ---- Payload enrichment ----

export function enrichPayload(data: Record<string, unknown>, context?: { release?: string; dist?: string }): Record<string, unknown> {
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
    const category = inferCategory(enrichedPayload.event_type)
    const priority = inferPriority(category)

    return {
        eventId: generateEventId(),
        appId,
        clientCreatedAt: Date.now(),
        category,
        priority,
        payload: enrichedPayload,
        retryCount: 0,
    }
}
