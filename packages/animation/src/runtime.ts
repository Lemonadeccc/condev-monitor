import type { PerformanceRuntimeEntry, PerformanceRuntimeEntryType } from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'
import {
    drainPerformanceEntries,
    getPerformanceRuntimeCapabilities,
    observePerformanceEntries,
    subscribeFrame,
    subscribePageLifecycle,
    subscribeResourceTimingBufferFull,
} from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'
import { subscribeWebVitals as subscribeSharedWebVitals } from '@condev-monitor/monitor-sdk-browser-utils/web-vitals-runtime'

import type {
    AnimationRuntime,
    CapabilityState,
    PerformanceObserverHandle,
    PerformanceSignalType,
    SanitizedPerformanceEntry,
    VisibilityState,
} from './types'

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
                disconnect: subscription,
            }
        },
    }
}
