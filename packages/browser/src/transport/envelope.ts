import { getBrowserInfo } from '@condev-monitor/monitor-sdk-browser-utils'

import type { EventCategory, EventPriority, ReportEnvelope } from './types'

// ---- DSN parsing (shared with replay) ----

export type ParsedDsn = {
    appId: string
    origin: string
    basePath: string
}

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
        const basePath = '/' + parts.slice(0, parts.length - 2).join('/')
        return { appId, origin: url.origin, basePath }
    } catch {
        return null
    }
}

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
    if (eventType === 'error') return 'error'
    if (eventType === 'whitescreen') return 'whitescreen'
    if (eventType.includes('vital') || eventType.includes('metric')) return 'webvital'
    if (eventType === 'longtask' || eventType === 'jank' || eventType === 'fps') return 'performance'
    return 'custom'
}

function inferPriority(category: EventCategory): EventPriority {
    return category === 'error' || category === 'whitescreen' ? 'immediate' : 'batch'
}

// ---- Payload enrichment ----

export function enrichPayload(data: Record<string, unknown>, context?: { release?: string; dist?: string }): Record<string, unknown> {
    const browserInfo = getBrowserInfo()
    const rawMessage = data['message']
    const message = typeof rawMessage === 'string' ? rawMessage : ''

    return {
        ...data,
        message,
        browserInfo,
        release: context?.release,
        dist: context?.dist,
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
