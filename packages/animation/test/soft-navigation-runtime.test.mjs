import assert from 'node:assert/strict'
import test from 'node:test'

import { AnimationCollector, createBrowserAnimationRuntime } from '../build/esm/index.mjs'

const SOFT_NAVIGATION_REGISTRY_KEY = Symbol.for('@condev-monitor/soft-navigation-web-vitals-runtime/v1')

class FakePerformanceObserver {
    static supportedEntryTypes = ['soft-navigation', 'layout-shift', 'event', 'first-input', 'interaction-contentful-paint']
    static instance

    constructor(callback) {
        this.callback = callback
        this.records = []
        FakePerformanceObserver.instance = this
    }

    observe() {}
    disconnect() {}

    takeRecords() {
        return this.records.splice(0)
    }

    emit(entries) {
        this.callback({ getEntries: () => entries })
    }
}

class SupportedSoftNavigation {
    getLargestInteractionContentfulPaint() {
        return null
    }
}

class SupportedEventTiming {
    get interactionId() {
        return 0
    }
}

function entry(entryType, startTime, fields = {}) {
    return {
        name: 'https://private.test/never-retain',
        entryType,
        startTime,
        duration: 0,
        toJSON: () => ({ selector: '#private', text: 'private' }),
        ...fields,
    }
}

test('browser runtime maps frozen finalized soft-navigation segments without private fields', async () => {
    const original = {
        window: globalThis.window,
        document: globalThis.document,
        PerformanceObserver: globalThis.PerformanceObserver,
        PerformanceSoftNavigation: globalThis.PerformanceSoftNavigation,
        PerformanceEventTiming: globalThis.PerformanceEventTiming,
        addEventListener: globalThis.addEventListener,
    }
    const documentListeners = new Map()
    const globalListeners = new Map()
    const fakeDocument = {
        visibilityState: 'visible',
        addEventListener(type, listener) {
            const listeners = documentListeners.get(type) ?? new Set()
            listeners.add(listener)
            documentListeners.set(type, listeners)
        },
    }

    delete globalThis[SOFT_NAVIGATION_REGISTRY_KEY]
    Object.assign(globalThis, {
        window: {},
        document: fakeDocument,
        PerformanceObserver: FakePerformanceObserver,
        PerformanceSoftNavigation: SupportedSoftNavigation,
        PerformanceEventTiming: SupportedEventTiming,
        addEventListener(type, listener) {
            const listeners = globalListeners.get(type) ?? new Set()
            listeners.add(listener)
            globalListeners.set(type, listeners)
        },
    })

    try {
        const runtime = createBrowserAnimationRuntime()
        assert.deepEqual(runtime.getSoftNavigationWebVitalsCapability(), {
            status: 'supported',
            metrics: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
        })

        const segments = []
        const unsubscribe = runtime.subscribeSoftNavigationFinalizedSegments(segment => segments.push(segment))
        FakePerformanceObserver.instance.emit([
            entry('soft-navigation', 100, {
                navigationId: 1,
                interactionId: 10,
                navigationURL: 'https://private.test/account/secret',
                getLargestInteractionContentfulPaint: () => null,
            }),
            entry('soft-navigation', 500, {
                navigationId: 2,
                interactionId: 20,
                getLargestInteractionContentfulPaint: () => null,
            }),
        ])
        await new Promise(resolve => setTimeout(resolve, 0))

        assert.equal(segments.length, 1)
        assert.deepEqual(segments[0], {
            schemaVersion: 1,
            segmentId: 1,
            startedAt: 100,
            finalizedAt: 500,
            elapsedMs: 400,
            reason: 'next-soft-navigation',
            capability: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
            observedUpdateCount: 0,
            droppedEntryCount: 0,
            rejectedUpdateCount: 0,
            latest: {
                CLS: {
                    name: 'CLS',
                    value: 0,
                    delta: 0,
                    rating: 'good',
                    navigationType: 'soft-navigation',
                    segmentId: 1,
                    startedAt: 100,
                    attribution: {},
                },
                INP: null,
                LCP: null,
            },
        })
        assert.equal(Object.isFrozen(segments[0]), true)
        assert.equal(Object.isFrozen(segments[0].capability), true)
        assert.equal(Object.isFrozen(segments[0].latest), true)
        assert.doesNotMatch(
            JSON.stringify(segments[0]),
            /private|navigationId|interactionId|navigationURL|url|selector|text|target|element/iu
        )
        unsubscribe()
        unsubscribe()
    } finally {
        delete globalThis[SOFT_NAVIGATION_REGISTRY_KEY]
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete globalThis[key]
            else globalThis[key] = value
        }
    }
})

test('collector snapshot remains document-scoped and does not embed soft-navigation segment arrays', () => {
    const runtime = {
        isBrowser: true,
        frameCapability: 'supported',
        now: () => 0,
        subscribeFrames: () => () => {},
        getVisibilityState: () => 'visible',
        onVisibilityChange: () => () => {},
        getReducedMotion: () => false,
        onReducedMotionChange: () => () => {},
        getSoftNavigationWebVitalsCapability: () => ({
            status: 'supported',
            metrics: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
        }),
        subscribeSoftNavigationFinalizedSegments: () => () => {},
        observePerformance: () => ({ state: 'unsupported', buffered: false, disconnect() {} }),
    }
    const snapshot = new AnimationCollector({ runtime }).start().stop()

    assert.equal(snapshot.webVitals.scope, 'document-lifetime')
    assert.equal('softNavigationReports' in snapshot, false)
    assert.equal('softNavigationSegments' in snapshot, false)
})
