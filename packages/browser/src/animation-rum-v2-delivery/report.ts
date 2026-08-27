import { ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES, validateNormalizedAnimationRumV2 } from '@condev-monitor/animation-rum-contract'

import type { AnimationRumV2DeliveryScope, AnimationRumV2QueuedReport } from './types'

export function prepareAnimationRumV2QueuedReport(
    scope: AnimationRumV2DeliveryScope,
    report: unknown,
    now: number
): AnimationRumV2QueuedReport {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Animation RUM v2 persistence time')
    const validation = validateNormalizedAnimationRumV2(report, { nowEpochMs: now })
    if (!validation.ok) throw new TypeError(`Invalid normalized Animation RUM v2 report: ${validation.errors.join(',')}`)

    const wirePayload = { event_type: 'animation_rum', ...validation.value }

    let payloadJson: string
    try {
        payloadJson = JSON.stringify(wirePayload)
    } catch {
        throw new TypeError('Animation RUM v2 report is not JSON serializable')
    }
    if (typeof payloadJson !== 'string') throw new TypeError('Animation RUM v2 report is not JSON serializable')
    const payloadBytes = new TextEncoder().encode(payloadJson).byteLength
    if (payloadBytes > ANIMATION_RUM_V2_MAX_PAYLOAD_BYTES) {
        throw new TypeError('Animation RUM v2 report exceeds the delivery byte limit')
    }
    const serialized = JSON.parse(payloadJson) as Record<string, unknown>
    if (serialized.event_type !== 'animation_rum') throw new TypeError('Animation RUM v2 transport type changed during serialization')
    const { event_type: _eventType, ...serializedNormalized } = serialized
    const serializedValidation = validateNormalizedAnimationRumV2(serializedNormalized, { nowEpochMs: now })
    if (!serializedValidation.ok) {
        throw new TypeError(`Invalid serialized Animation RUM v2 report: ${serializedValidation.errors.join(',')}`)
    }
    // The parsed clone is the only metadata authority: it is byte-for-byte
    // equivalent to what IndexedDB retains and every retry uploads. Never read
    // accessors on the caller-owned object again after this point.
    const normalized = serializedValidation.value
    const eventId = normalized.eventId
    const captureId = normalized.captureId
    const parentCaptureId = normalized.parentCaptureId

    return {
        key: JSON.stringify([scope.scopeKey, eventId]),
        scopeKey: scope.scopeKey,
        appId: scope.appId,
        trackingUrl: scope.trackingUrl,
        eventId,
        captureId,
        reportScope: normalized.scope,
        parentCaptureId,
        payloadJson,
        payloadBytes,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
        attemptCount: 0,
        state: 'pending',
        parentConfirmed: normalized.scope === 'page',
        leaseOwner: null,
        leaseUntil: 0,
        settledAt: null,
        terminalReason: null,
    }
}
