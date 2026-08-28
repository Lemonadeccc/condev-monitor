import { ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES, validateNormalizedAnimationRumV3 } from '@condev-monitor/animation-rum-contract'

import type { AnimationRumV3DeliveryScope, AnimationRumV3QueuedReport } from './types'

export function prepareAnimationRumV3QueuedReport(
    scope: AnimationRumV3DeliveryScope,
    report: unknown,
    now: number
): AnimationRumV3QueuedReport {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Animation RUM v3 soft navigation persistence time')
    const validation = validateNormalizedAnimationRumV3(report, { nowEpochMs: now })
    if (!validation.ok) throw new TypeError(`Invalid normalized Animation RUM v3 soft navigation report: ${validation.errors.join(',')}`)

    const wirePayload = { event_type: 'animation_soft_navigation_rum', ...validation.value }

    let payloadJson: string
    try {
        payloadJson = JSON.stringify(wirePayload)
    } catch {
        throw new TypeError('Animation RUM v3 soft navigation report is not JSON serializable')
    }
    if (typeof payloadJson !== 'string') throw new TypeError('Animation RUM v3 soft navigation report is not JSON serializable')
    const payloadBytes = new TextEncoder().encode(payloadJson).byteLength
    if (payloadBytes > ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES) {
        throw new TypeError('Animation RUM v3 soft navigation report exceeds the delivery byte limit')
    }
    const serialized = JSON.parse(payloadJson) as Record<string, unknown>
    if (serialized.event_type !== 'animation_soft_navigation_rum')
        throw new TypeError('Animation RUM v3 soft navigation transport type changed during serialization')
    const { event_type: _eventType, ...serializedNormalized } = serialized
    const serializedValidation = validateNormalizedAnimationRumV3(serializedNormalized, { nowEpochMs: now })
    if (!serializedValidation.ok) {
        throw new TypeError(`Invalid serialized Animation RUM v3 soft navigation report: ${serializedValidation.errors.join(',')}`)
    }
    // The parsed clone is the only metadata authority: it is byte-for-byte
    // equivalent to what IndexedDB retains and every retry uploads. Never read
    // accessors on the caller-owned object again after this point.
    const normalized = serializedValidation.value
    const eventId = normalized.eventId
    const captureId = normalized.captureId
    return {
        key: JSON.stringify([scope.scopeKey, eventId]),
        scopeKey: scope.scopeKey,
        appId: scope.appId,
        trackingUrl: scope.trackingUrl,
        eventId,
        captureId,
        payloadJson,
        payloadBytes,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
        attemptCount: 0,
        state: 'pending',
        leaseOwner: null,
        leaseUntil: 0,
        settledAt: null,
        terminalReason: null,
    }
}
