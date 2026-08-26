import assert from 'node:assert/strict'
import test from 'node:test'

import { AnimationCollector, recommendAnimationImprovements, toAnimationRumSummary } from '../build/esm/index.mjs'

class EvidenceRuntime {
    constructor({ webVitals = false, reducedMotion = false } = {}) {
        this.isBrowser = true
        this.frameCapability = 'supported'
        this.time = 0
        this.visibility = 'visible'
        this.reducedMotion = reducedMotion
        this.frames = new Set()
        this.visibilityListeners = new Set()
        this.motionListeners = new Set()
        this.vitalListeners = new Set()
        this.vitalUnsubscribeCount = 0
        if (webVitals) {
            this.subscribeWebVitals = callback => {
                this.vitalListeners.add(callback)
                let active = true
                return () => {
                    if (!active) return
                    active = false
                    this.vitalUnsubscribeCount += 1
                    this.vitalListeners.delete(callback)
                }
            }
        }
    }

    now() {
        return this.time
    }

    wallNow() {
        return 1_750_000_000_000 + this.time
    }

    subscribeFrames(callback) {
        this.frames.add(callback)
        return () => this.frames.delete(callback)
    }

    getVisibilityState() {
        return this.visibility
    }

    onVisibilityChange(callback) {
        this.visibilityListeners.add(callback)
        return () => this.visibilityListeners.delete(callback)
    }

    getReducedMotion() {
        return this.reducedMotion
    }

    onReducedMotionChange(callback) {
        this.motionListeners.add(callback)
        return () => this.motionListeners.delete(callback)
    }

    observePerformance() {
        return { state: 'supported', buffered: true, disconnect() {} }
    }

    drainPendingPerformanceEntries() {}

    tick(delta) {
        this.time += delta
        if (this.visibility === 'visible') {
            for (const callback of [...this.frames]) callback(this.time)
        }
    }

    advance(delta) {
        this.time += delta
    }

    setVisibility(state) {
        this.visibility = state
        for (const callback of [...this.visibilityListeners]) callback(state)
    }

    emitWebVital(metric) {
        for (const callback of [...this.vitalListeners]) callback(metric)
    }
}

function collectFrames(runtime, count, delta = 16.667) {
    runtime.tick(0)
    for (let index = 0; index < count; index += 1) runtime.tick(delta)
}

test('capture sufficiency uses visible duration, retained frames, refresh confidence, and truncation as evidence gates', () => {
    const runtime = new EvidenceRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60, maxFrames: 64 }).start()
    collectFrames(runtime, 30)

    const short = collector.snapshot()
    assert.equal(short.captureSufficiency.status, 'insufficient')
    assert.deepEqual(short.captureSufficiency.reasons, ['visible-window-too-short'])
    assert.equal(short.coverage.frameCadence.status, 'partial')
    const shortRum = toAnimationRumSummary(short, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(shortRum.metrics.find(metric => metric.name === 'frameDurationMs' && metric.stat === 'p95').status, 'partial')
    assert.equal(shortRum.metrics.find(metric => metric.name === 'slowFrameRate').status, 'partial')
    assert.equal(shortRum.metrics.find(metric => metric.name === 'targetFrameMs').status, 'measured')

    runtime.advance(4_501)
    const sufficient = collector.snapshot()
    assert.equal(sufficient.captureSufficiency.status, 'sufficient')
    assert.deepEqual(sufficient.captureSufficiency.reasons, [])
    assert.equal(sufficient.coverage.frameCadence.status, 'measured')
    const sufficientRum = toAnimationRumSummary(sufficient, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(sufficientRum.metrics.find(metric => metric.name === 'frameDurationMs' && metric.stat === 'p95').status, 'measured')

    runtime.setVisibility('hidden')
    runtime.advance(2_000)
    const stopped = collector.stop()
    assert.ok(stopped.captureSufficiency.visibleDurationMs >= 5_000)
    assert.equal(stopped.captureSufficiency.hiddenDurationMs, 2_000)
    assert.equal(stopped.captureSufficiency.otherDurationMs, 0)
})

test('hidden elapsed time cannot upgrade a short visible frame recommendation to high confidence', () => {
    const runtime = new EvidenceRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60, maxFrames: 64 }).start()
    collectFrames(runtime, 29)
    runtime.tick(40)
    runtime.setVisibility('hidden')
    runtime.advance(6_000)

    const snapshot = collector.stop()
    assert.ok(snapshot.elapsedMs > 5_000)
    assert.ok(snapshot.captureSufficiency.visibleDurationMs < 5_000)
    assert.equal(snapshot.captureSufficiency.status, 'insufficient')
    const frameRecommendation = recommendAnimationImprovements(snapshot).find(
        recommendation => recommendation.id === 'frame-tail-and-bursts'
    )
    assert.ok(frameRecommendation)
    assert.equal(frameRecommendation.confidence, 'low')
})

test('an inferred fallback frame budget stays partial until capture evidence is sufficient', () => {
    const runtime = new EvidenceRuntime()
    const snapshot = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, 3)
    const captured = snapshot.stop()
    assert.equal(captured.frameBudget.source, 'inferred')
    assert.equal(captured.captureSufficiency.status, 'insufficient')

    const rum = toAnimationRumSummary(captured, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(rum.metrics.find(metric => metric.name === 'targetFrameMs').status, 'partial')
    assert.equal(rum.metrics.find(metric => metric.name === 'inferredRefreshHz').status, 'partial')
})

test('document-lifetime Web Vitals are local, replay-safe sanitized evidence and stay outside animation_rum v1 metrics', () => {
    const runtime = new EvidenceRuntime({ webVitals: true })
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    runtime.emitWebVital({
        name: 'LCP',
        value: 1_250,
        delta: 1_250,
        rating: 'good',
        navigationType: 'navigate',
        attribution: {
            timeToFirstByte: 100,
            resourceLoadDelay: 25,
            resourceLoadDuration: 300,
            elementRenderDelay: 825,
            url: 'https://private.example/hero.jpg',
            element: { id: 'private-hero' },
        },
        id: 'private-id',
        entries: [{ name: 'https://private.example/hero.jpg' }],
    })
    runtime.emitWebVital({
        name: 'CLS',
        value: Number.NaN,
        delta: 0,
        rating: 'good',
        navigationType: 'navigate',
        attribution: {},
    })

    const snapshot = collector.stop()
    assert.equal(snapshot.webVitals.scope, 'document-lifetime')
    assert.equal(snapshot.webVitals.observedUpdateCount, 1)
    assert.equal(snapshot.webVitals.latest.LCP.value, 1_250)
    assert.deepEqual(snapshot.webVitals.latest.LCP.attribution, {
        timeToFirstByte: 100,
        resourceLoadDelay: 25,
        resourceLoadDuration: 300,
        elementRenderDelay: 825,
    })
    assert.equal(snapshot.webVitals.latest.CLS, null)
    assert.equal(snapshot.capabilities.webVitalsAttribution, true)
    assert.equal(snapshot.capabilities.webVitalsDisabled, false)
    assert.equal(runtime.vitalUnsubscribeCount, 1)
    const serializedVitals = JSON.stringify(snapshot.webVitals)
    assert.equal(serializedVitals.includes('private.example'), false)
    assert.equal(serializedVitals.includes('private-id'), false)
    assert.equal(serializedVitals.includes('private-hero'), false)
    assert.doesNotMatch(serializedVitals, /"(?:url|entries|id)"/i)

    const rum = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(
        rum.metrics.some(metric => ['LCP', 'INP', 'CLS'].includes(metric.name)),
        false
    )
    assert.equal(JSON.stringify(rum).includes('1250'), false)
})

test('continuous interaction quality rejects invalid evidence, bounds samples, and reports explicit local summaries', () => {
    const runtime = new EvidenceRuntime()
    const collector = new AnimationCollector({
        runtime,
        explicitRefreshHz: 60,
        maxInteractionQualitySamples: 2,
    }).start()
    const interaction = collector.beginInteraction('drag', 'gallery drag')

    assert.equal(interaction.recordQuality({}), false)
    assert.equal(interaction.recordQuality({ coalescedEventsAvailable: 2, coalescedEventsConsumed: 3 }), false)
    assert.equal(interaction.recordQuality({ inputToVisualMs: 18, progressError: 0.05 }), true)
    assert.equal(interaction.recordQuality({ inputToVisualMs: 12, progressError: 0.1 }), true)
    assert.equal(
        interaction.recordQuality({
            inputToVisualMs: 10,
            pointerSampleAgeMs: 8,
            coalescedEventsAvailable: 4,
            coalescedEventsConsumed: 3,
            intendedProgress: 0.7,
            visualProgress: 0.5,
            domWebglAlignmentErrorPx: 2,
            controlWritersPerFrame: 2,
            settleTimeMs: 120,
            overshootRatio: 0.1,
            oscillationCount: 1,
        }),
        true
    )
    runtime.advance(250)
    const ended = interaction.end()
    assert.equal(interaction.recordQuality({ inputToVisualMs: 1 }), false)

    const quality = ended.performance.quality
    assert.equal(quality.status, 'partial')
    assert.equal(quality.acceptedSampleCount, 3)
    assert.equal(quality.retainedSampleCount, 2)
    assert.equal(quality.droppedSampleCount, 1)
    assert.equal(quality.rejectedSampleCount, 2)
    assert.equal(quality.inputToVisual.count, 2)
    assert.equal(quality.inputToVisual.max, 12)
    assert.equal(quality.progressError.p95, 0.195)
    assert.equal(quality.controllerConflictSampleCount, 1)
    assert.equal(quality.coalescedEventsAvailable, 4)
    assert.equal(quality.coalescedEventsConsumed, 3)
    assert.equal(quality.coalescedEventUtilization, 0.75)

    const snapshot = collector.stop()
    assert.equal(snapshot.interactions.recent[0].performance.quality.acceptedSampleCount, 3)
    assert.equal(snapshot.coverage.scrollGesture.status, 'partial')
    assert.equal(snapshot.coverage.motionQuality.status, 'partial')
    assert.equal(snapshot.coverage.memoryLifecycle.status, 'not-instrumented')
    assert.equal(snapshot.coverage.accessibility.status, 'not-instrumented')

    const recommendations = recommendAnimationImprovements(snapshot, {
        inputToVisualBudgetMs: 5,
        progressErrorBudget: 0.02,
        domWebglAlignmentErrorBudgetPx: 1,
        controlWritersPerFrameBudget: 1,
        settleTimeBudgetMs: 100,
        overshootRatioBudget: 0.05,
    })
    const ids = recommendations.map(recommendation => recommendation.id)
    assert.ok(ids.includes('continuous-input-to-visual'))
    assert.ok(ids.includes('visual-progress-drift'))
    assert.ok(ids.includes('competing-progress-writers'))
    assert.ok(ids.includes('dom-webgl-alignment-drift'))
    assert.ok(ids.includes('coalesced-event-utilization'))
    assert.match(recommendations.find(recommendation => recommendation.id === 'visual-progress-drift').why, /gallery drag/)
    assert.equal(recommendations.find(recommendation => recommendation.id === 'coalesced-event-utilization').expectedDirection, 'increase')
})
