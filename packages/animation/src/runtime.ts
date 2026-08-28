import type { PerformanceRuntimeEntry, PerformanceRuntimeEntryType } from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'
import {
    drainPerformanceEntries,
    getPerformanceRuntimeCapabilities,
    observePerformanceEntries,
    subscribeFrame,
    subscribePageLifecycle,
    subscribeResourceTimingBufferFull,
} from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'
import type {
    SoftNavigationFinalizedSegmentSnapshot,
    SoftNavigationWebVitalsCapability,
    SoftNavigationWebVitalSnapshot,
} from '@condev-monitor/monitor-sdk-browser-utils/web-vitals-runtime'
import {
    getSoftNavigationWebVitalsCapability as getSharedSoftNavigationWebVitalsCapability,
    subscribeSoftNavigationFinalizedSegments as subscribeSharedSoftNavigationFinalizedSegments,
    subscribeWebVitals as subscribeSharedWebVitals,
} from '@condev-monitor/monitor-sdk-browser-utils/web-vitals-runtime'

import type {
    AnimationRuntime,
    AnimationSoftNavigationFinalizedSegmentSnapshot,
    AnimationSoftNavigationWebVitalMeasurement,
    AnimationSoftNavigationWebVitalsCapability,
    CapabilityState,
    PerformanceObserverHandle,
    PerformanceSignalType,
    SanitizedPerformanceEntry,
    VisibilityState,
} from './types'

function mapSoftNavigationCapability(capability: SoftNavigationWebVitalsCapability): AnimationSoftNavigationWebVitalsCapability {
    return Object.freeze({
        status: capability.status,
        ...(capability.reason ? { reason: capability.reason } : {}),
        metrics: Object.freeze({ ...capability.metrics }),
    })
}

function mapSoftNavigationMetric(metric: SoftNavigationWebVitalSnapshot): AnimationSoftNavigationWebVitalMeasurement {
    const base = {
        name: metric.name,
        value: metric.value,
        delta: metric.delta,
        rating: metric.rating,
        navigationType: metric.navigationType,
        segmentId: metric.segmentId,
        startedAt: metric.startedAt,
        attribution: Object.freeze({ ...metric.attribution }),
    }
    return Object.freeze(base) as AnimationSoftNavigationWebVitalMeasurement
}

function mapOptionalSoftNavigationMetric<Name extends AnimationSoftNavigationWebVitalMeasurement['name']>(
    metric: Extract<SoftNavigationWebVitalSnapshot, { name: Name }> | null
): Extract<AnimationSoftNavigationWebVitalMeasurement, { name: Name }> | null {
    return metric ? (mapSoftNavigationMetric(metric) as Extract<AnimationSoftNavigationWebVitalMeasurement, { name: Name }>) : null
}

function mapFinalizedSoftNavigationSegment(
    segment: SoftNavigationFinalizedSegmentSnapshot
): AnimationSoftNavigationFinalizedSegmentSnapshot {
    return Object.freeze({
        schemaVersion: 1,
        segmentId: segment.segmentId,
        startedAt: segment.startedAt,
        finalizedAt: segment.finalizedAt,
        elapsedMs: segment.elapsedMs,
        reason: segment.reason,
        capability: Object.freeze({ ...segment.capability }),
        observedUpdateCount: segment.observedUpdateCount,
        droppedEntryCount: segment.droppedEntryCount,
        rejectedUpdateCount: segment.rejectedUpdateCount,
        latest: Object.freeze({
            CLS: mapOptionalSoftNavigationMetric(segment.latest.CLS),
            INP: mapOptionalSoftNavigationMetric(segment.latest.INP),
            LCP: mapOptionalSoftNavigationMetric(segment.latest.LCP),
        }),
    })
}

function visibilityState(documentValue: Document | undefined): VisibilityState {
    const value = documentValue?.visibilityState
    if (value === 'visible' || value === 'hidden' || value === 'prerender') return value
    return 'unknown'
}

function unsupportedHandle(state: CapabilityState, reason: string): PerformanceObserverHandle {
    return {
        state,
        buffered: false,
        reason,
        disconnect() {},
    }
}

function sanitizedEntry(entry: PerformanceRuntimeEntry): SanitizedPerformanceEntry {
    if (entry.entryType === 'resource') {
        return {
            startTime: entry.startTime,
            duration: entry.duration,
            resourceInitiatorType: entry.initiatorType,
            ...(entry.responseEnd === null ? {} : { responseEnd: entry.responseEnd }),
            ...(entry.transferSize === null ? {} : { transferSize: entry.transferSize }),
            ...(entry.encodedBodySize === null ? {} : { encodedBodySize: entry.encodedBodySize }),
            ...(entry.decodedBodySize === null ? {} : { decodedBodySize: entry.decodedBodySize }),
        }
    }
    if (entry.entryType === 'long-animation-frame') {
        return {
            startTime: entry.startTime,
            duration: entry.duration,
            ...(entry.blockingDuration === null ? {} : { blockingDuration: entry.blockingDuration }),
            ...(entry.renderStart === null ? {} : { renderStart: entry.renderStart }),
            ...(entry.styleAndLayoutStart === null ? {} : { styleAndLayoutStart: entry.styleAndLayoutStart }),
            ...('paintTime' in entry ? { paintTime: entry.paintTime ?? null } : {}),
            ...('presentationTime' in entry ? { presentationTime: entry.presentationTime ?? null } : {}),
        }
    }
    if (entry.entryType === 'event') {
        return {
            startTime: entry.startTime,
            duration: entry.duration,
            ...(entry.processingStart === null ? {} : { processingStart: entry.processingStart }),
            ...(entry.processingEnd === null ? {} : { processingEnd: entry.processingEnd }),
            ...(entry.interactionId === null ? {} : { interactionId: entry.interactionId }),
        }
    }
    return { startTime: entry.startTime, duration: entry.duration }
}

/**
 * Adapter over browser-utils' process-wide runtime hub. It owns no rAF clock,
 * PerformanceObserver, or visibility listener of its own.
 */
export function createBrowserAnimationRuntime(): AnimationRuntime {
    const windowValue = typeof window === 'undefined' ? undefined : window
    const documentValue = typeof document === 'undefined' ? undefined : document
    const browser = Boolean(windowValue && documentValue)
    const runtimeCapabilities = getPerformanceRuntimeCapabilities()

    return {
        isBrowser: browser,
        frameCapability: runtimeCapabilities.frame ? 'supported' : 'unsupported',
        now(): number {
            return typeof performance === 'undefined' ? Date.now() : performance.now()
        },
        wallNow(): number {
            return Date.now()
        },
        subscribeFrames(callback): () => void {
            return subscribeFrame(sample => callback(sample.timestamp))
        },
        getVisibilityState(): VisibilityState {
            return visibilityState(documentValue)
        },
        onVisibilityChange(callback): () => void {
            return subscribePageLifecycle(
                event => {
                    if (event.type === 'hidden' || event.type === 'pagehide') callback('hidden')
                    else callback('visible')
                },
                { priority: 75 }
            )
        },
        onPageLifecycle(callback, options): () => void {
            return subscribePageLifecycle(callback, options)
        },
        onResourceTimingBufferFull(callback): PerformanceObserverHandle {
            if (!browser) return unsupportedHandle('unknown', 'browser runtime unavailable')
            const subscription = subscribeResourceTimingBufferFull(callback)
            return {
                state: subscription.state,
                buffered: false,
                ...(subscription.reason ? { reason: subscription.reason } : {}),
                disconnect: subscription,
            }
        },
        getReducedMotion(): boolean | null {
            if (!windowValue?.matchMedia) return null
            return windowValue.matchMedia('(prefers-reduced-motion: reduce)').matches
        },
        onReducedMotionChange(callback): () => void {
            if (!windowValue?.matchMedia) return () => undefined
            const query = windowValue.matchMedia('(prefers-reduced-motion: reduce)')
            const listener = (event: MediaQueryListEvent): void => callback(event.matches)
            query.addEventListener?.('change', listener)
            return () => query.removeEventListener?.('change', listener)
        },
        subscribeWebVitals(callback): () => void {
            if (!browser) return () => undefined
            return subscribeSharedWebVitals(metric => callback(metric), { delivery: 'live', replayLatest: true })
        },
        getSoftNavigationWebVitalsCapability(): AnimationSoftNavigationWebVitalsCapability {
            return mapSoftNavigationCapability(getSharedSoftNavigationWebVitalsCapability())
        },
        subscribeSoftNavigationFinalizedSegments(callback): () => void {
            if (!browser) return () => undefined
            return subscribeSharedSoftNavigationFinalizedSegments(segment => callback(mapFinalizedSoftNavigationSegment(segment)), {
                replayLatest: true,
            })
        },
        drainPendingPerformanceEntries(): void {
            drainPerformanceEntries()
        },
        observePerformance(type: PerformanceSignalType, callback): PerformanceObserverHandle {
            if (!browser) return unsupportedHandle('unknown', 'browser runtime unavailable')
            const subscription = observePerformanceEntries(
                type as PerformanceRuntimeEntryType,
                entry => callback([sanitizedEntry(entry)]),
                { buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) }
            )
            return {
                state: subscription.state,
                buffered: subscription.buffered,
                ...(subscription.reason ? { reason: subscription.reason } : {}),
                get droppedEntriesCount(): number | null {
                    return subscription.droppedEntriesCount
                },
                disconnect: subscription,
            }
        },
    }
}
