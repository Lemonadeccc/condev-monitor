import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore describedby keyshortcuts rawframes rvfc useremail

import {
    ANIMATION_RUM_MAX_WINDOW_DURATION_MS,
    AnimationCollector,
    AnimationIntegration,
    AnimationStateError,
    AnimationUnsupportedError,
    createBrowserAnimationRuntime,
    createAnimationElementPicker,
    createAnimationTargetAdapterRegistry,
    createFrameworkComponentScope,
    createFrameworkCommitProbe,
    deterministicAnimationRumSample,
    projectAnimationLocalEvidenceSnapshot,
    recommendAnimationImprovements,
    toAnimationRumSummary,
} from '../build/esm/index.mjs'
import { createAnimationDevOverlay, projectAnimationOverlayPageEvidenceSnapshot } from '../build/esm/devtools.mjs'

test('framework component scopes keep closed local evidence in a bounded inspection window', () => {
    const times = [10, 18, 20, 25, 30, 37]
    const scope = createFrameworkComponentScope({
        framework: 'react',
        label: 'Private component label',
        maxRecords: 2,
        now: () => times.shift(),
    })

    assert.equal(
        scope.record({
            kind: 'render',
            reason: 'react-mount',
            reasonSource: 'react-profiler-phase',
            durationMs: 8,
            baseRenderMs: 11,
        }),
        true
    )
    assert.equal(
        scope.record({
            kind: 'render',
            reason: 'react-update',
            reasonSource: 'react-profiler-phase',
            durationMs: 5,
            baseRenderMs: 9,
        }),
        true
    )
    assert.equal(
        scope.record({
            kind: 'commit-attested',
            reason: 'host-independent-commit',
            reasonSource: 'host-independent-measurement',
            durationMs: 7,
        }),
        true
    )
    assert.equal(
        scope.record({
            kind: 'commit-attested',
            reason: 'react-update',
            reasonSource: 'react-profiler-phase',
            durationMs: 1,
        }),
        false
    )

    const snapshot = scope.snapshot({ startedAt: 0, endedAt: 40 })
    assert.equal(snapshot.framework, 'react')
    assert.equal(snapshot.label, 'Private component label')
    assert.equal(snapshot.retainedRecordCount, 2)
    assert.equal(snapshot.droppedRecordCount, 1)
    assert.deepEqual(
        snapshot.records.map(record => record.kind),
        ['render', 'commit-attested']
    )
    assert.deepEqual(
        scope.snapshot({ startedAt: 0, endedAt: 19 }).records.map(record => record.reason),
        ['react-update']
    )
    assert.equal(JSON.stringify(scope.snapshot({ startedAt: 0, endedAt: 40 })).includes('props'), false)
    scope.dispose()
    assert.equal(scope.record({ kind: 'render', reason: 'react-update', reasonSource: 'react-profiler-phase', durationMs: 1 }), false)
})

class FakeRuntime {
    constructor({
        browser = true,
        visibility = 'visible',
        reducedMotion = false,
        capabilities = {},
        frameCapability,
        drainError = false,
        performanceObserverDroppedEntries,
    } = {}) {
        this.isBrowser = browser
        this.frameCapability = frameCapability ?? (browser ? 'supported' : 'unsupported')
        this.time = 0
        this.epoch = 1_750_000_000_000
        this.visibility = visibility
        this.reducedMotion = reducedMotion
        this.capabilities = {
            'long-animation-frame': 'supported',
            longtask: 'supported',
            event: 'supported',
            ...capabilities,
        }
        this.frames = new Set()
        this.visibilityListeners = new Set()
        this.motionListeners = new Set()
        this.lifecycleListeners = new Set()
        this.observers = new Map()
        this.pendingEntries = new Map()
        this.drainError = drainError
        this.performanceObserverDroppedEntries = performanceObserverDroppedEntries
        this.disconnectCount = 0
    }

    now() {
        return this.time
    }

    wallNow() {
        return this.epoch + this.time
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

    onPageLifecycle(callback, options = {}) {
        const subscriber = { callback, priority: options.priority ?? 0 }
        this.lifecycleListeners.add(subscriber)
        return () => this.lifecycleListeners.delete(subscriber)
    }

    observePerformance(type, callback) {
        const state = this.capabilities[type] ?? 'unknown'
        if (state === 'supported') {
            const callbacks = this.observers.get(type) ?? new Set()
            callbacks.add(callback)
            this.observers.set(type, callbacks)
        }
        let disconnected = false
        const handle = {
            state,
            buffered: state === 'supported',
            ...(state === 'supported' ? {} : { reason: `${type} ${state}` }),
            disconnect: () => {
                if (disconnected) return
                disconnected = true
                this.disconnectCount += 1
                this.observers.get(type)?.delete(callback)
            },
        }
        if (this.performanceObserverDroppedEntries && Object.hasOwn(this.performanceObserverDroppedEntries, type)) {
            Object.defineProperty(handle, 'droppedEntriesCount', {
                enumerable: true,
                get: () => this.performanceObserverDroppedEntries[type],
            })
        }
        return handle
    }

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

    setReducedMotion(reduced) {
        this.reducedMotion = reduced
        for (const callback of [...this.motionListeners]) callback(reduced)
    }

    emit(type, entries) {
        for (const callback of [...(this.observers.get(type) ?? [])]) callback(entries)
    }

    queue(type, entries) {
        const pending = this.pendingEntries.get(type) ?? []
        pending.push(...entries)
        this.pendingEntries.set(type, pending)
    }

    drainPendingPerformanceEntries() {
        if (this.drainError) throw new Error('synthetic drain failure')
        const pending = [...this.pendingEntries.entries()]
        this.pendingEntries.clear()
        for (const [type, entries] of pending) this.emit(type, entries)
    }

    emitLifecycle(event) {
        const subscribers = [...this.lifecycleListeners].sort((left, right) => right.priority - left.priority)
        for (const subscriber of subscribers) subscriber.callback(event)
    }

    get observerCount() {
        return [...this.observers.values()].reduce((sum, callbacks) => sum + callbacks.size, 0)
    }
}

function collectFrames(runtime, deltas) {
    runtime.tick(0)
    for (const delta of deltas) runtime.tick(delta)
}

function assertSupportedZeroSignalRum(report) {
    const findMetric = (name, stat) => report.metrics.find(metric => metric.name === name && metric.stat === stat)
    for (const [name, stat] of [
        ['longAnimationFrameCount', 'count'],
        ['longAnimationFrameDurationMs', 'sum'],
        ['longTaskCount', 'count'],
        ['longTaskDurationMs', 'sum'],
    ]) {
        const aggregate = findMetric(name, stat)
        assert.deepEqual([aggregate.value, aggregate.samples, aggregate.status], [0, 0, 'measured'])
    }
    for (const [name, stat] of [
        ['longAnimationFrameDurationMs', 'p95'],
        ['longAnimationFrameBlockingMs', 'p95'],
        ['longAnimationFrameStyleLayoutTailMs', 'p95'],
        ['longTaskDurationMs', 'p95'],
        ['longTaskDurationMs', 'max'],
    ]) {
        const distribution = findMetric(name, stat)
        assert.deepEqual([distribution.value, distribution.samples, distribution.status], [null, null, 'not-observed'])
    }
}

test('visible rAF capture reports percentiles, slow ratio, missed opportunities, and contiguous bursts', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60, maxFrames: 16 }).start()
    collectFrames(runtime, [16, 17, 30, 31, 16, 50])

    const snapshot = collector.stop()
    assert.equal(snapshot.frameBudget.source, 'explicit')
    assert.equal(snapshot.frameBudget.expectedRefreshHz, 60)
    assert.equal(snapshot.frames.retainedCount, 6)
    assert.equal(snapshot.frames.duration.count, 6)
    assert.equal(snapshot.frames.duration.max, 50)
    assert.equal(snapshot.frames.slowFrameCount, 3)
    assert.equal(snapshot.frames.slowFrameRatio, 0.5)
    assert.equal(snapshot.bursts.count, 2)
    assert.equal(snapshot.bursts.longestFrameCount, 2)
    assert.ok(snapshot.frames.missedFrameOpportunities >= 4)
})

test('bounded frame ring exposes dropped coverage and never normalizes a degraded 30fps stream as healthy', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({
        runtime,
        maxFrames: 4,
        inferenceMinimumSamples: 4,
    }).start()
    collectFrames(runtime, [33.333, 33.333, 33.333, 33.333, 33.333, 33.333])

    const snapshot = collector.stop()
    assert.equal(snapshot.frames.retainedCount, 4)
    assert.equal(snapshot.frames.totalObservedCount, 6)
    assert.equal(snapshot.frames.droppedSampleCount, 2)
    assert.equal(snapshot.frameBudget.expectedRefreshHz, 60)
    assert.equal(snapshot.frameBudget.confidence, 'low')
    assert.equal(snapshot.frames.slowFrameRatio, 1)
})

test('conservative inference recognizes a stable high-refresh stream', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, inferenceMinimumSamples: 4 }).start()
    collectFrames(runtime, [8.333, 8.333, 8.333, 8.333, 8.333])
    const snapshot = collector.stop()
    assert.equal(snapshot.frameBudget.expectedRefreshHz, 120)
    assert.equal(snapshot.frameBudget.source, 'inferred')
    assert.equal(snapshot.frameBudget.confidence, 'medium')
})

test('hidden periods cancel rAF and reset the timestamp so background gaps are not frames', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    runtime.tick(0)
    runtime.tick(16)
    runtime.setVisibility('hidden')
    runtime.advance(2_000)
    assert.equal(runtime.frames.size, 1)
    runtime.setVisibility('visible')
    runtime.tick(0)
    runtime.tick(16)

    const snapshot = collector.stop()
    assert.equal(snapshot.frames.retainedCount, 2)
    assert.equal(snapshot.frames.duration.max, 16)
    assert.equal(snapshot.visibility.hiddenTransitionCount, 1)
    assert.equal(snapshot.visibility.visibleTransitionCount, 1)
})

test('input dispatch scheduling uses the shared rAF callback entry and stays distinct from visual evidence', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, maxInputFrameSchedulingSamples: 2 }).start()
    assert.equal(collector.snapshot().inputFrameScheduling.status, 'not-instrumented')

    const recorder = collector.createInputFrameSchedulingRecorder()
    runtime.advance(10.1236)
    const pointerMarker = recorder.record('pointer')
    assert.equal(pointerMarker.accepted, true)
    runtime.advance(0.0002)
    const interaction = collector.beginInteraction('pointer', 'automatic-pointer-window')
    assert.equal(pointerMarker.associateInteraction(interaction.id), true)
    runtime.advance(7.9998)
    for (const callback of [...runtime.frames]) callback(12)
    runtime.advance(1)
    interaction.end()
    const correlated = collector.snapshot().interactions.recent[0].performance.inputFrameScheduling
    assert.equal(correlated.duration.p95, 8)
    assert.equal(correlated.status, 'measured')

    assert.equal(recorder.record('keyboard').accepted, true)
    runtime.advance(4)
    for (const callback of [...runtime.frames]) callback(15)
    assert.equal(recorder.record('click').accepted, true)
    runtime.advance(6)
    for (const callback of [...runtime.frames]) callback(16)

    recorder.dispose()
    const snapshot = collector.stop()
    assert.equal(snapshot.inputFrameScheduling.status, 'partial')
    assert.equal(snapshot.inputFrameScheduling.totalObservedCount, 3)
    assert.equal(snapshot.inputFrameScheduling.retainedCount, 2)
    assert.equal(snapshot.inputFrameScheduling.droppedSampleCount, 1)
    assert.deepEqual(snapshot.inputFrameScheduling.byKind, { pointer: 1, keyboard: 1, click: 1 })
    assert.equal(snapshot.inputFrameScheduling.duration.p95, 5.9)
    assert.equal(snapshot.interactions.recent[0].performance.inputFrameScheduling.status, 'partial')
    assert.equal(snapshot.interactions.recent[0].performance.inputFrameScheduling.totalObservedCount, 1)
    assert.equal(snapshot.interactions.recent[0].performance.inputFrameScheduling.retainedCount, 0)
    assert.equal(snapshot.interactions.recent[0].performance.inputFrameScheduling.droppedSampleCount, 1)
    assert.equal(snapshot.interactions.recent[0].performance.inputFrameScheduling.duration, null)
    assert.equal(snapshot.interactions.recent[0].performance.quality.inputToVisual, null)

    const report = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(report.metrics.length, 32)
    assert.equal(JSON.stringify(report).includes('inputFrameScheduling'), false)
})

test('input dispatch scheduling bounds pending work and cancels hidden or stopped samples without manufacturing zeroes', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const recorder = collector.createInputFrameSchedulingRecorder()

    for (let index = 0; index < 8; index += 1) assert.equal(recorder.record('pointer').accepted, true)
    assert.equal(recorder.record('pointer').accepted, false)
    runtime.setVisibility('hidden')
    let snapshot = collector.snapshot()
    assert.equal(snapshot.inputFrameScheduling.status, 'not-observed')
    assert.equal(snapshot.inputFrameScheduling.duration, null)
    assert.equal(snapshot.inputFrameScheduling.droppedSampleCount, 1)
    assert.equal(snapshot.inputFrameScheduling.cancelledSampleCount, 8)

    runtime.setVisibility('visible')
    assert.equal(recorder.record('keyboard').accepted, true)
    recorder.dispose()
    snapshot = collector.stop()
    assert.equal(snapshot.inputFrameScheduling.status, 'not-observed')
    assert.equal(snapshot.inputFrameScheduling.cancelledSampleCount, 9)
    assert.equal(snapshot.inputFrameScheduling.pendingCount, 0)
})

test('input scheduling attributes invalid durations and ring loss only to their associated interaction', () => {
    const invalidRuntime = new FakeRuntime()
    const invalidCollector = new AnimationCollector({ runtime: invalidRuntime }).start()
    const invalidRecorder = invalidCollector.createInputFrameSchedulingRecorder()
    const invalidMarker = invalidRecorder.record('pointer')
    const invalidInteraction = invalidCollector.beginInteraction('pointer', 'invalid-duration-window')
    assert.equal(invalidMarker.associateInteraction(invalidInteraction.id), true)
    invalidRuntime.advance(600_001)
    for (const callback of [...invalidRuntime.frames]) callback(invalidRuntime.now())
    invalidInteraction.end()
    const invalidSummary = invalidCollector.snapshot().interactions.recent[0].performance.inputFrameScheduling
    assert.equal(invalidSummary.status, 'partial')
    assert.equal(invalidSummary.totalObservedCount, 0)
    assert.equal(invalidSummary.droppedSampleCount, 1)
    assert.equal(invalidSummary.cancelledSampleCount, 0)
    assert.equal(invalidSummary.duration, null)
    invalidRecorder.dispose()
    invalidCollector.stop()

    const ringRuntime = new FakeRuntime()
    const ringCollector = new AnimationCollector({
        runtime: ringRuntime,
        maxInteractions: 1,
        maxInputFrameSchedulingSamples: 1,
    }).start()
    const ringRecorder = ringCollector.createInputFrameSchedulingRecorder()
    for (const label of ['first', 'second']) {
        const marker = ringRecorder.record('click')
        const interaction = ringCollector.beginInteraction('pointer', label)
        assert.equal(marker.associateInteraction(interaction.id), true)
        ringRuntime.advance(4)
        for (const callback of [...ringRuntime.frames]) callback(ringRuntime.now())
        interaction.end()
    }
    ringCollector.beginInteraction('custom', 'unrelated-new-window').end()
    const ringSnapshot = ringCollector.snapshot()
    const unrelated = ringSnapshot.interactions.recent[0].performance.inputFrameScheduling
    assert.equal(ringSnapshot.inputFrameScheduling.droppedSampleCount, 1)
    assert.equal(unrelated.status, 'not-observed')
    assert.equal(unrelated.totalObservedCount, 0)
    assert.equal(unrelated.droppedSampleCount, 0)
    assert.equal(unrelated.cancelledSampleCount, 0)
    assert.equal(ringCollector.inputFrameSchedulingResolvedByInteraction.size, 0)
    ringRecorder.dispose()
    ringCollector.stop()
})

test('bounded local signals retain presentation delay and interaction overlap, marking truncation partial', () => {
    const runtime = new FakeRuntime({ reducedMotion: true })
    const collector = new AnimationCollector({
        runtime,
        explicitRefreshHz: 60,
        maxFrames: 1,
        maxSignalEntries: 1,
    }).start()
    const interaction = collector.beginInteraction('drag', 'private .card[data-user="42"]')
    collectFrames(runtime, [16, 32])
    runtime.emit('long-animation-frame', [
        { startTime: 2, duration: 54, blockingDuration: 12, styleAndLayoutStart: 30 },
        { startTime: 40, duration: 70, blockingDuration: 20, styleAndLayoutStart: 70 },
    ])
    runtime.emit('longtask', [
        { startTime: 3, duration: 60 },
        { startTime: 55, duration: 58 },
    ])
    runtime.emit('event', [
        { startTime: 4, duration: 40, processingStart: 10, processingEnd: 25 },
        { startTime: 40, duration: 80, processingStart: 70, processingEnd: 100 },
    ])
    const live = collector.snapshot()
    assert.equal(live.interactions.active.length, 1)
    assert.equal(live.interactions.active[0].performance.frames.status, 'partial')
    runtime.advance(100)
    const ended = interaction.end()
    const snapshot = collector.stop()
    const recent = snapshot.interactions.recent[0]

    assert.equal(ended.outcome, 'completed')
    assert.equal(recent.label, 'private .card[data-user="42"]')
    assert.equal(recent.performance.frames.status, 'partial')
    assert.equal(recent.performance.longAnimationFrames.status, 'partial')
    assert.equal(recent.performance.longTasks.status, 'partial')
    assert.equal(recent.performance.eventTiming.status, 'partial')
    assert.equal(recent.performance.longTasks.overlapCount, 1)
    assert.equal(snapshot.eventTiming.presentationDelay.p95, 20)
    assert.equal(snapshot.eventTiming.presentationDelayCapability.state, 'supported')
    assert.equal(snapshot.longTasks.droppedSampleCount, 1)
    assert.equal(snapshot.longAnimationFrames.styleAndLayoutTailDuration.p95, 40)
    assert.equal('styleAndLayoutDuration' in snapshot.longAnimationFrames, false)
})

test('browser buffered-history drops stay separate from SDK rings and lower affected page confidence', () => {
    const browserDrops = {
        'long-animation-frame': 2,
        longtask: 3,
        event: 4,
        resource: 5,
    }
    const runtime = new FakeRuntime({
        capabilities: { resource: 'supported' },
        performanceObserverDroppedEntries: browserDrops,
    })
    const collector = new AnimationCollector({ runtime }).start()
    const interaction = collector.beginInteraction('pointer', 'observer-drop-window')
    runtime.emit('long-animation-frame', [{ startTime: 10, duration: 80, blockingDuration: 20, styleAndLayoutStart: 40 }])
    runtime.emit('longtask', [{ startTime: 10, duration: 80 }])
    runtime.emit('event', [{ startTime: 20, duration: 180, processingStart: 140, processingEnd: 170 }])
    runtime.emit('resource', [
        {
            startTime: 10,
            duration: 120,
            resourceInitiatorType: 'script',
            transferSize: 100,
            encodedBodySize: 90,
            decodedBodySize: 110,
        },
    ])
    runtime.advance(250)
    interaction.end()
    const snapshot = collector.stop()

    assert.deepEqual(
        [
            snapshot.longAnimationFrames.performanceObserverDroppedEntryCount,
            snapshot.longTasks.performanceObserverDroppedEntryCount,
            snapshot.eventTiming.performanceObserverDroppedEntryCount,
            snapshot.resourceTiming.performanceObserverDroppedEntryCount,
        ],
        [2, 3, 4, 5]
    )
    assert.deepEqual(
        [
            snapshot.longAnimationFrames.droppedSampleCount,
            snapshot.longTasks.droppedSampleCount,
            snapshot.eventTiming.droppedSampleCount,
            snapshot.resourceTiming.droppedSampleCount,
        ],
        [0, 0, 0, 0]
    )
    assert.deepEqual(
        [
            snapshot.interactions.recent[0].performance.longAnimationFrames.status,
            snapshot.interactions.recent[0].performance.longTasks.status,
            snapshot.interactions.recent[0].performance.eventTiming.status,
        ],
        ['measured', 'measured', 'measured']
    )

    const rum = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const rumMetric = (name, stat) => rum.metrics.find(metric => metric.name === name && metric.stat === stat)
    assert.equal(rumMetric('longAnimationFrameCount', 'count').status, 'partial')
    assert.equal(rumMetric('longTaskCount', 'count').status, 'partial')
    assert.equal(rumMetric('inputDelayMs', 'p95').status, 'partial')
    assert.equal(JSON.stringify(rum).includes('performanceObserverDroppedEntryCount'), false)

    const recommendations = recommendAnimationImprovements(snapshot)
    for (const id of ['long-task-main-thread', 'loaf-rendering-tail', 'event-input-delay']) {
        assert.equal(recommendations.find(item => item.id === id).confidence, 'low')
    }

    const legacySnapshot = new AnimationCollector({ runtime: new FakeRuntime() }).start().stop()
    assert.equal('performanceObserverDroppedEntryCount' in legacySnapshot.longTasks, false)
    const zeroRuntime = new FakeRuntime({ performanceObserverDroppedEntries: { longtask: 0 } })
    const zeroSnapshot = new AnimationCollector({ runtime: zeroRuntime }).start().stop()
    const zeroRum = toAnimationRumSummary(zeroSnapshot, {
        capturedAtEpochMs: zeroRuntime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(zeroSnapshot.longTasks.performanceObserverDroppedEntryCount, 0)
    assert.equal(zeroRum.metrics.find(metric => metric.name === 'longTaskCount' && metric.stat === 'count').status, 'measured')

    const missingHistoryRuntime = new FakeRuntime({
        performanceObserverDroppedEntries: { longtask: Number.MAX_SAFE_INTEGER + 1 },
    })
    const missingHistorySnapshot = new AnimationCollector({ runtime: missingHistoryRuntime }).start().stop()
    const missingHistoryRum = toAnimationRumSummary(missingHistorySnapshot, {
        capturedAtEpochMs: missingHistoryRuntime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(missingHistorySnapshot.longTasks.performanceObserverDroppedEntryCount, Number.MAX_SAFE_INTEGER)
    assert.equal(missingHistoryRum.metrics.find(metric => metric.name === 'longTaskCount' && metric.stat === 'count').status, 'partial')
    assert.equal(
        missingHistoryRum.metrics.find(metric => metric.name === 'longTaskDurationMs' && metric.stat === 'p95').status,
        'not-observed'
    )
})

test('LoAF rendering tail omits zero and out-of-interval styleAndLayoutStart values', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    runtime.emit('long-animation-frame', [
        { startTime: 10, duration: 60, styleAndLayoutStart: 0 },
        { startTime: 100, duration: 60, styleAndLayoutStart: 90 },
        { startTime: 200, duration: 60, styleAndLayoutStart: 261 },
    ])
    runtime.advance(300)
    const snapshot = collector.stop()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const renderingTail = summary.metrics.find(metric => metric.name === 'longAnimationFrameStyleLayoutTailMs')

    assert.equal(snapshot.longAnimationFrames.totalObservedCount, 3)
    assert.equal(snapshot.longAnimationFrames.styleAndLayoutTailDuration, null)
    assert.equal(snapshot.coverage.renderingPipeline.status, 'not-observed')
    assert.equal(renderingTail.value, null)
    assert.equal(renderingTail.samples, null)
    assert.equal(renderingTail.status, 'not-observed')
})

test('LoAF paint timing distinguishes missing fields, exposed null values, and complete phase evidence', () => {
    const noEntryRuntime = new FakeRuntime()
    const noEntrySnapshot = new AnimationCollector({ runtime: noEntryRuntime }).start().stop()
    assert.equal(noEntrySnapshot.longAnimationFrames.paintTiming.paintTimeCapability.state, 'unknown')
    assert.equal(noEntrySnapshot.longAnimationFrames.paintTiming.paintTimeExposedCount, null)
    assert.equal(noEntrySnapshot.capabilities.longAnimationFramePaintTime, null)

    const preCaptureRuntime = new FakeRuntime()
    preCaptureRuntime.advance(100)
    const preCaptureCollector = new AnimationCollector({ runtime: preCaptureRuntime }).start()
    preCaptureRuntime.emit('long-animation-frame', [{ startTime: 10, duration: 50, renderStart: 30, paintTime: 45, presentationTime: 50 }])
    const preCapture = preCaptureCollector.stop()
    assert.equal(preCapture.longAnimationFrames.paintTiming.paintTimeCapability.state, 'unknown')
    assert.equal(preCapture.longAnimationFrames.paintTiming.paintTimeExposedCount, null)

    const missingRuntime = new FakeRuntime()
    const missingCollector = new AnimationCollector({ runtime: missingRuntime }).start()
    missingRuntime.emit('long-animation-frame', [{ startTime: 10, duration: 80, renderStart: 30 }])
    const missing = missingCollector.stop()
    assert.equal(missing.longAnimationFrames.paintTiming.paintTimeCapability.state, 'unsupported')
    assert.equal(missing.longAnimationFrames.paintTiming.presentationTimeCapability.state, 'unsupported')
    assert.equal(missing.longAnimationFrames.paintTiming.paintTimeExposedCount, 0)
    assert.equal(missing.longAnimationFrames.paintTiming.renderStartToPaintTotalObservedCount, null)
    assert.equal(missing.capabilities.longAnimationFramePaintTime, false)
    assert.equal(missing.capabilities.longAnimationFramePresentationTime, false)

    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    runtime.emit('long-animation-frame', [
        { startTime: 10, duration: 100, renderStart: 30, paintTime: 70, presentationTime: 85 },
        { startTime: 120, duration: 100, renderStart: 150, paintTime: 180, presentationTime: null },
    ])
    runtime.advance(250)
    const snapshot = collector.stop()
    const paintTiming = snapshot.longAnimationFrames.paintTiming

    assert.equal(paintTiming.paintTimeCapability.state, 'supported')
    assert.equal(paintTiming.presentationTimeCapability.state, 'supported')
    assert.equal(paintTiming.paintTimeExposedCount, 2)
    assert.equal(paintTiming.presentationTimeExposedCount, 2)
    assert.equal(paintTiming.renderStartToPaintTotalObservedCount, 2)
    assert.equal(paintTiming.paintToPresentationTotalObservedCount, 1)
    assert.deepEqual([paintTiming.renderStartToPaintDuration.count, paintTiming.renderStartToPaintDuration.total], [2, 70])
    assert.deepEqual([paintTiming.paintToPresentationDuration.count, paintTiming.paintToPresentationDuration.p95], [1, 15])
    assert.equal(snapshot.capabilities.longAnimationFramePaintTime, true)
    assert.equal(snapshot.capabilities.longAnimationFramePresentationTime, true)
})

test('LoAF paint timing fails closed for invalid boundaries and retains full-stream counts after ring eviction', () => {
    const invalidRuntime = new FakeRuntime()
    invalidRuntime.advance(50)
    const invalidCollector = new AnimationCollector({ runtime: invalidRuntime }).start()
    invalidRuntime.emit('long-animation-frame', [
        // Crossing the capture boundary is valid only because both phase endpoints are inside it.
        { startTime: 10, duration: 100, renderStart: 60, paintTime: 80, presentationTime: 120 },
        { startTime: 150, duration: 80, renderStart: 180, paintTime: 170, presentationTime: 190 },
        { startTime: 250, duration: 80, renderStart: 270, paintTime: 340, presentationTime: 350 },
        { startTime: 350, duration: 80, renderStart: 370, paintTime: 390, presentationTime: 380 },
        { startTime: 450, duration: 80, renderStart: 470, paintTime: null, presentationTime: null },
    ])
    invalidRuntime.advance(550)
    const invalid = invalidCollector.stop().longAnimationFrames.paintTiming
    assert.equal(invalid.paintTimeCapability.state, 'supported')
    assert.equal(invalid.presentationTimeCapability.state, 'supported')
    assert.equal(invalid.renderStartToPaintTotalObservedCount, 2)
    assert.equal(invalid.paintToPresentationTotalObservedCount, 2)
    assert.deepEqual([invalid.renderStartToPaintDuration.count, invalid.renderStartToPaintDuration.total], [2, 40])
    assert.deepEqual([invalid.paintToPresentationDuration.count, invalid.paintToPresentationDuration.total], [2, 60])

    const ringRuntime = new FakeRuntime()
    const ringCollector = new AnimationCollector({ runtime: ringRuntime, maxSignalEntries: 1 }).start()
    ringRuntime.emit('long-animation-frame', [
        { startTime: 10, duration: 100, renderStart: 30, paintTime: 70, presentationTime: 80 },
        { startTime: 120, duration: 100, renderStart: 150, paintTime: null, presentationTime: null },
    ])
    ringRuntime.advance(250)
    const ringSnapshot = ringCollector.stop()
    const ringPaintTiming = ringSnapshot.longAnimationFrames.paintTiming
    assert.equal(ringSnapshot.longAnimationFrames.totalObservedCount, 2)
    assert.equal(ringSnapshot.longAnimationFrames.retainedCount, 1)
    assert.equal(ringSnapshot.longAnimationFrames.droppedSampleCount, 1)
    assert.equal(ringPaintTiming.renderStartToPaintTotalObservedCount, 1)
    assert.equal(ringPaintTiming.paintToPresentationTotalObservedCount, 1)
    assert.equal(ringPaintTiming.renderStartToPaintDuration, null)
    assert.equal(ringPaintTiming.paintToPresentationDuration, null)
})

test('RUM percentile samples count only entries that expose each optional LoAF and Event Timing phase', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    runtime.emit('long-animation-frame', [
        { startTime: 10, duration: 80, blockingDuration: 10, styleAndLayoutStart: 50 },
        { startTime: 100, duration: 80, blockingDuration: 20 },
        { startTime: 200, duration: 80, styleAndLayoutStart: 240 },
        { startTime: 300, duration: 80 },
    ])
    runtime.emit('event', [
        { startTime: 10, duration: 80, processingStart: 20, processingEnd: 40 },
        { startTime: 100, duration: 80, processingStart: 120 },
        { startTime: 200, duration: 80, processingEnd: 240 },
        { startTime: 300, duration: 80 },
    ])
    runtime.advance(400)
    const snapshot = collector.stop()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const samplesFor = (name, family) => summary.metrics.find(metric => metric.name === name && metric.family === family)?.samples

    assert.equal(snapshot.longAnimationFrames.duration.count, 4)
    assert.equal(snapshot.longAnimationFrames.blockingDuration.count, 2)
    assert.equal(snapshot.longAnimationFrames.styleAndLayoutTailDuration.count, 2)
    assert.equal(snapshot.eventTiming.duration.count, 4)
    assert.equal(snapshot.eventTiming.inputDelay.count, 2)
    assert.equal(snapshot.eventTiming.processingDuration.count, 1)
    assert.equal(snapshot.eventTiming.presentationDelay.count, 2)

    assert.equal(samplesFor('longAnimationFrameDurationMs', 'mainThread'), 4)
    assert.equal(samplesFor('longAnimationFrameBlockingMs', 'mainThread'), 2)
    assert.equal(samplesFor('longAnimationFrameStyleLayoutTailMs', 'renderingPipeline'), 2)
    assert.equal(samplesFor('eventTimingDurationMs', 'userOutcome'), 4)
    assert.equal(samplesFor('inputDelayMs', 'userOutcome'), 2)
    assert.equal(samplesFor('processingDurationMs', 'userOutcome'), 1)
    assert.equal(samplesFor('presentationDelayMs', 'renderingPipeline'), 2)
})

test('Resource Timing stays privacy-safe, capture-scoped, bounded, and local-only', () => {
    const runtime = new FakeRuntime({ capabilities: { resource: 'supported' } })
    const bufferCallbacks = new Set()
    runtime.onResourceTimingBufferFull = callback => {
        bufferCallbacks.add(callback)
        let disconnected = false
        return {
            state: 'supported',
            buffered: false,
            disconnect() {
                if (disconnected) return
                disconnected = true
                bufferCallbacks.delete(callback)
            },
        }
    }
    runtime.advance(100)
    const collector = new AnimationCollector({ runtime, maxResourceEntries: 2 }).start()

    runtime.emit('resource', [
        {
            startTime: 90,
            duration: 30,
            resourceInitiatorType: 'fetch',
            transferSize: 50,
            encodedBodySize: 40,
            decodedBodySize: 80,
            name: 'https://private.example/pre-capture?token=secret',
        },
        {
            startTime: 110,
            duration: 10,
            resourceInitiatorType: 'script',
            transferSize: 100,
            encodedBodySize: 90,
            decodedBodySize: 90,
            name: 'https://private.example/app.js?token=secret',
        },
        {
            startTime: 120,
            duration: 20,
            resourceInitiatorType: 'img',
            transferSize: 0,
            encodedBodySize: 200,
            decodedBodySize: 1_000,
            name: 'https://private.example/avatar.png?user=42',
        },
        {
            startTime: 140,
            duration: 30,
            resourceInitiatorType: 'video',
            transferSize: 300,
            encodedBodySize: 250,
            decodedBodySize: 500,
            name: 'https://private.example/movie.mp4',
        },
        { startTime: Number.NaN, duration: 5, resourceInitiatorType: 'script' },
    ])
    for (const callback of [...bufferCallbacks]) callback()
    runtime.advance(100)

    const snapshot = collector.stop()
    const resources = snapshot.resourceTiming
    assert.equal(resources.scope, 'capture-window')
    assert.equal(resources.capability.state, 'supported')
    assert.equal(resources.bufferEventCapability.state, 'supported')
    assert.equal(resources.totalObservedCount, 3)
    assert.equal(resources.retainedCount, 2)
    assert.equal(resources.droppedSampleCount, 1)
    assert.equal(resources.rejectedEntryCount, 1)
    assert.equal(resources.excludedPreCaptureCount, 1)
    assert.equal(resources.bufferFullEventCount, 1)
    assert.equal(resources.transferSizeBytes, 400)
    assert.equal(resources.encodedBodySizeBytes, 540)
    assert.equal(resources.decodedBodySizeBytes, 1_590)
    assert.equal(resources.zeroTransferSizeCount, 1)
    assert.equal(resources.duration.p95, 29.5)
    assert.equal(resources.categories.script.totalObservedCount, 1)
    assert.equal(resources.categories.image.zeroTransferSizeCount, 1)
    assert.equal(resources.categories.media.totalObservedCount, 1)
    assert.equal(snapshot.coverage.resourcesMedia.status, 'partial')

    const localJson = JSON.stringify(resources)
    assert.doesNotMatch(localJson, /private\.example|token=|avatar|movie\.mp4/)

    const rum = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal('resourceTiming' in rum, false)
    assert.equal(
        rum.metrics.some(metric => metric.family === 'resourcesMedia' || metric.unit === 'bytes'),
        false
    )
    assert.equal(rum.capabilities.resourceTiming, true)
    assert.equal(rum.capabilities.resourceTimingBufferEvents, true)
    assert.deepEqual(rum.coverage.resourcesMedia, {
        status: 'not-instrumented',
        evidenceLevel: 'unsupported-or-unknown',
    })
})

test('explicit host evidence is bounded, capture-clocked, coverage-aware, and excluded from RUM v1', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, maxHostEvidenceSamples: 2 })
    assert.equal(
        collector.recordFrameworkStats({
            source: 'manual',
            framework: 'react',
            phase: 'mount',
            renderMs: 1,
            timestampMs: 999_999,
        }),
        false
    )
    collector.start()
    const frameworkProbe = createFrameworkCommitProbe({ framework: 'react', sink: collector, now: () => 999_999 })
    assert.equal(frameworkProbe.recordCommit({ phase: 'mount', renderMs: 1 }), true)
    runtime.advance(10)
    assert.equal(frameworkProbe.recordCommit({ phase: 'update', renderMs: 2, commitMs: 1 }), true)
    runtime.advance(10)
    assert.equal(frameworkProbe.recordCommit({ phase: 'update', renderMs: 3 }), true)
    runtime.advance(10)
    assert.equal(frameworkProbe.recordUpdateWindow({ updateWindowMs: 8 }), true)
    assert.equal(
        collector.recordFrameworkStats({
            source: 'manual',
            framework: 'react',
            phase: 'update',
            renderMs: Number.NaN,
            timestampMs: 0,
        }),
        false
    )
    for (const invalidFrameworkSample of [
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'update',
            updateWindowMs: 7,
            renderMs: 1,
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'update',
            updateWindowMs: 7,
            commitMs: 1,
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'update',
            updateWindowMs: 7,
            baseRenderMs: 1,
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'mount',
            updateWindowMs: 7,
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'update',
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'react',
            phase: 'update',
            updateWindowMs: 600_001,
            timestampMs: 0,
        },
        {
            source: 'manual',
            framework: 'react',
            phase: 'update',
            renderMs: 1,
            updateWindowMs: 7,
            timestampMs: 0,
        },
        {
            source: 'react-profiler',
            framework: 'react',
            phase: 'update',
            renderMs: 1,
            updateWindowMs: 7,
            timestampMs: 0,
        },
    ]) {
        assert.equal(collector.recordFrameworkStats(invalidFrameworkSample), false)
    }
    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'webgl2',
            timestampMs: 0,
            drawCalls: 4,
            gpu: {
                status: 'measured',
                timeMs: 2.5,
                source: 'webgl-disjoint-timer-query',
                valid: false,
                disjoint: true,
                contextLost: false,
            },
        }),
        false
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'webgl2',
            timestampMs: 999_999,
            drawCalls: 4,
            triangles: 120,
            gpu: {
                status: 'measured',
                timeMs: 2.5,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }),
        true
    )
    assert.equal(
        collector.recordLifecycleStats({
            source: 'gsap-public-api',
            checkpoint: 'unmount',
            timestampMs: 0,
            animations: { status: 'measured', total: 2, active: 1, rejectedActiveChecks: 3 },
            scrollTriggers: { status: 'measured', total: 0 },
        }),
        false
    )
    assert.equal(
        collector.recordLifecycleStats({
            source: 'gsap-public-api',
            checkpoint: 'unmount',
            timestampMs: 999_999,
            animations: { status: 'measured', total: 2, active: 0 },
            scrollTriggers: { status: 'measured', total: 0 },
        }),
        true
    )
    assert.equal(collector.recordWorkStats({ source: 'host', timestampMs: 999_999, workMs: 4, category: 'layout' }), true)
    assert.equal(
        collector.recordMediaStats({
            source: 'video-rvfc',
            timestampMs: 999_999,
            callbackIntervalMs: 16,
            presentedFramesDelta: 1,
            playbackQuality: {
                status: 'measured',
                totalVideoFramesDelta: 2,
                droppedVideoFramesDelta: 1,
                corruptedVideoFramesDelta: 0,
            },
        }),
        true
    )

    const snapshot = collector.stop()
    assert.equal(snapshot.hostEvidence.scope, 'capture-window-local')
    assert.deepEqual(
        [
            snapshot.hostEvidence.framework.acceptedSampleCount,
            snapshot.hostEvidence.framework.retainedSampleCount,
            snapshot.hostEvidence.framework.droppedSampleCount,
            snapshot.hostEvidence.framework.rejectedSampleCount,
        ],
        [4, 2, 2, 9]
    )
    assert.equal(snapshot.hostEvidence.framework.detailScope, 'retained-samples')
    assert.equal(snapshot.hostEvidence.framework.retainedEvidenceSampleCount, 2)
    assert.equal(snapshot.hostEvidence.framework.acceptedWindow.startedAt, 0)
    assert.equal(snapshot.hostEvidence.framework.acceptedWindow.endedAt, 30)
    assert.equal(snapshot.hostEvidence.framework.window.startedAt, 20)
    assert.equal(snapshot.hostEvidence.framework.window.endedAt, 30)
    assert.equal(snapshot.hostEvidence.framework.renderMs.p95, 3)
    assert.equal(snapshot.hostEvidence.framework.updateWindowMs.p95, 8)
    assert.equal(snapshot.hostEvidence.renderer.gpuFrameMs.p95, 2.5)
    assert.equal(snapshot.hostEvidence.renderer.gpuTimerCapability, 'supported')
    assert.equal(snapshot.hostEvidence.lifecycle.latestAnimationTotal, 2)
    assert.equal(snapshot.hostEvidence.lifecycle.growthCandidate, null)
    assert.equal(snapshot.hostEvidence.work.categories.layout, 1)
    assert.equal(snapshot.hostEvidence.media.playbackDropRatio, 0.5)
    assert.equal(snapshot.hostEvidence.media.playbackQualityMeasuredSampleCount, 1)
    assert.equal(snapshot.hostEvidence.media.playbackQualityUnsupportedSampleCount, 0)
    assert.equal(snapshot.hostEvidence.media.playbackQualityErrorSampleCount, 0)
    assert.equal(snapshot.coverage.renderer.status, 'partial')
    assert.equal(snapshot.coverage.resourcesMedia.status, 'partial')
    assert.equal(snapshot.coverage.memoryLifecycle.status, 'partial')
    assert.equal(snapshot.coverage.workAvoidance.status, 'not-instrumented')
    assert.equal(frameworkProbe.recordCommit({ renderMs: 1 }), false)
    assert.equal(collector.recordWorkStats({ source: 'host', timestampMs: 0, workMs: 1, category: 'script' }), false)

    const rum = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal('hostEvidence' in rum, false)
    assert.doesNotMatch(JSON.stringify(rum.metrics), /gpuFrameMs|drawCalls|playbackDropRatio|renderMs/)
    assert.equal(rum.coverage.renderer.status, 'not-instrumented')
    assert.equal(rum.coverage.resourcesMedia.status, 'not-instrumented')
    assert.equal(rum.coverage.memoryLifecycle.status, 'not-instrumented')
    assert.equal(rum.coverage.workAvoidance.status, 'not-instrumented')

    const emptyRuntime = new FakeRuntime()
    const emptyMedia = new AnimationCollector({ runtime: emptyRuntime }).start().stop().hostEvidence.media
    assert.equal(emptyMedia.playbackQualityMeasuredSampleCount, 0)
    assert.equal(emptyMedia.playbackQualityUnsupportedSampleCount, 0)
    assert.equal(emptyMedia.playbackQualityErrorSampleCount, 0)
    assert.equal(emptyMedia.totalVideoFramesDelta, null)
    assert.equal(emptyMedia.droppedVideoFramesDelta, null)
    assert.equal(emptyMedia.corruptedVideoFramesDelta, null)
    assert.equal(emptyMedia.playbackDropRatio, null)

    const missingCorruptedRuntime = new FakeRuntime()
    const missingCorruptedCollector = new AnimationCollector({ runtime: missingCorruptedRuntime }).start()
    assert.equal(
        missingCorruptedCollector.recordMediaStats({
            source: 'video-rvfc',
            timestampMs: 0,
            callbackIntervalMs: 16,
            playbackQuality: { status: 'measured', totalVideoFramesDelta: 2, droppedVideoFramesDelta: 0 },
        }),
        true
    )
    const missingCorrupted = missingCorruptedCollector.stop().hostEvidence.media
    assert.equal(missingCorrupted.totalVideoFramesDelta, 2)
    assert.equal(missingCorrupted.droppedVideoFramesDelta, 0)
    assert.equal(missingCorrupted.corruptedVideoFramesDelta, null)

    const unsupportedMediaRuntime = new FakeRuntime()
    const unsupportedMediaCollector = new AnimationCollector({ runtime: unsupportedMediaRuntime }).start()
    assert.equal(
        unsupportedMediaCollector.recordMediaStats({
            source: 'video-rvfc',
            timestampMs: 0,
            callbackIntervalMs: 16,
            playbackQuality: { status: 'unsupported' },
        }),
        true
    )
    const unsupportedMedia = unsupportedMediaCollector.stop().hostEvidence.media
    assert.equal(unsupportedMedia.playbackQualityMeasuredSampleCount, 0)
    assert.equal(unsupportedMedia.playbackQualityUnsupportedSampleCount, 1)
    assert.equal(unsupportedMedia.playbackQualityErrorSampleCount, 0)
    assert.equal(unsupportedMedia.totalVideoFramesDelta, null)
    assert.equal(unsupportedMedia.droppedVideoFramesDelta, null)
    assert.equal(unsupportedMedia.corruptedVideoFramesDelta, null)

    const errorMediaRuntime = new FakeRuntime()
    const errorMediaCollector = new AnimationCollector({ runtime: errorMediaRuntime }).start()
    assert.equal(
        errorMediaCollector.recordMediaStats({
            source: 'video-rvfc',
            timestampMs: 0,
            callbackIntervalMs: 16,
            playbackQuality: { status: 'error' },
        }),
        true
    )
    const errorMedia = errorMediaCollector.stop().hostEvidence.media
    assert.equal(errorMedia.playbackQualityMeasuredSampleCount, 0)
    assert.equal(errorMedia.playbackQualityUnsupportedSampleCount, 0)
    assert.equal(errorMedia.playbackQualityErrorSampleCount, 1)
})

test('framework check windows stay distinct from updates, render, commit, paint, and GPU work', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime })
    collector.start()
    const probe = createFrameworkCommitProbe({ framework: 'angular', sink: collector, now: () => 999_999 })

    runtime.advance(4)
    assert.equal(probe.recordCheckWindow({ checkWindowMs: 4 }), true)
    for (const invalidSample of [
        {
            source: 'framework-check',
            framework: 'angular',
            phase: 'update',
            checkWindowMs: 4,
            timestampMs: 0,
        },
        {
            source: 'framework-check',
            framework: 'angular',
            phase: 'check',
            checkWindowMs: 4,
            renderMs: 1,
            timestampMs: 0,
        },
        {
            source: 'framework-check',
            framework: 'angular',
            phase: 'check',
            timestampMs: 0,
        },
        {
            source: 'framework-lifecycle',
            framework: 'angular',
            phase: 'update',
            updateWindowMs: 4,
            checkWindowMs: 4,
            timestampMs: 0,
        },
        {
            source: 'manual',
            framework: 'angular',
            phase: 'check',
            renderMs: 1,
            checkWindowMs: 4,
            timestampMs: 0,
        },
    ]) {
        assert.equal(collector.recordFrameworkStats(invalidSample), false)
    }

    const snapshot = collector.stop()
    assert.deepEqual(snapshot.hostEvidence.framework.frameworks, ['angular'])
    assert.equal(snapshot.hostEvidence.framework.phases.check, 1)
    assert.equal(snapshot.hostEvidence.framework.checkWindowMs.p95, 4)
    assert.equal(snapshot.hostEvidence.framework.updateWindowMs, null)
    assert.equal(snapshot.hostEvidence.framework.renderMs, null)
    assert.equal(snapshot.hostEvidence.framework.commitMs, null)
    assert.equal(snapshot.hostEvidence.framework.rejectedSampleCount, 5)
})

test('host renderer evidence rejects backend-specific GPU sources from a different backend', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()

    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'webgpu',
            timestampMs: 0,
            gpu: {
                status: 'measured',
                timeMs: 2.5,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }),
        false
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'unknown',
            timestampMs: 0,
            gpu: {
                status: 'measured',
                timeMs: 1.5,
                source: 'host-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }),
        true
    )

    const renderer = collector.stop().hostEvidence.renderer
    assert.equal(renderer.rejectedSampleCount, 1)
    assert.equal(renderer.gpuMeasuredSampleCount, 1)
    assert.equal(renderer.gpuRejectedSampleCount, 0)
    assert.equal(renderer.gpuTimerCapability, 'supported')
})

test('host renderer evidence preserves explicit GPU timer capability and infers legacy callers', () => {
    const summarize = sample => {
        const runtime = new FakeRuntime()
        const collector = new AnimationCollector({ runtime }).start()
        const accepted = collector.recordRenderStats({
            source: 'renderer-host',
            backend: 'webgl2',
            timestampMs: 0,
            ...sample,
        })
        return { accepted, renderer: collector.stop().hostEvidence.renderer }
    }

    for (const gpuTimerCapability of ['supported', 'unsupported', 'disabled', 'unknown']) {
        const { accepted, renderer } = summarize({ gpuTimerCapability, gpu: { status: 'not-provided' } })
        assert.equal(accepted, true)
        assert.equal(renderer.gpuTimerCapability, gpuTimerCapability)
    }

    assert.equal(
        summarize({
            gpu: {
                status: 'measured',
                timeMs: 1,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }).renderer.gpuTimerCapability,
        'supported'
    )
    assert.equal(summarize({ gpu: { status: 'disjoint' } }).renderer.gpuTimerCapability, 'unknown')
    assert.equal(summarize({ gpu: { status: 'not-provided' } }).renderer.gpuTimerCapability, 'disabled')

    for (const sample of [
        { gpuTimerCapability: 'future-capability', gpu: { status: 'not-provided' } },
        {
            gpuTimerCapability: 'unsupported',
            gpu: {
                status: 'measured',
                timeMs: 1,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        },
        { gpuTimerCapability: 'disabled', gpu: { status: 'error' } },
        { gpuTimerCapability: 'supported', gpu: { status: 'context-lost' } },
        { gpuTimerCapability: 'supported', gpu: { status: 'error' } },
        { backend: 'canvas2d', gpuTimerCapability: 'supported', gpu: { status: 'not-provided' } },
    ]) {
        const { backend = 'webgl2', ...reading } = sample
        const runtime = new FakeRuntime()
        const collector = new AnimationCollector({ runtime }).start()
        const accepted = collector.recordRenderStats({
            source: 'renderer-host',
            backend,
            timestampMs: 0,
            ...reading,
        })
        const renderer = collector.stop().hostEvidence.renderer
        assert.equal(accepted, false)
        assert.equal(renderer.gpuTimerCapability, 'unknown')
        assert.equal(renderer.rejectedSampleCount, 1)
    }
})

test('host renderer GPU capability is stable across multiple probe capture orders', () => {
    const summarize = capabilities => {
        const runtime = new FakeRuntime()
        const collector = new AnimationCollector({ runtime }).start()
        for (const [index, gpuTimerCapability] of capabilities.entries()) {
            runtime.time = index
            assert.equal(
                collector.recordRenderStats({
                    source: 'renderer-host',
                    backend: index === 0 ? 'webgl2' : 'webgl',
                    timestampMs: index,
                    gpuTimerCapability,
                    gpu: { status: 'not-provided' },
                }),
                true
            )
        }
        return collector.stop().hostEvidence.renderer.gpuTimerCapability
    }

    assert.equal(summarize(['supported', 'unsupported']), 'supported')
    assert.equal(summarize(['unsupported', 'supported']), 'supported')
    assert.equal(summarize(['unsupported', 'disabled']), 'unknown')
    assert.equal(summarize(['disabled', 'unsupported']), 'unknown')
    assert.equal(summarize(['unknown', 'unsupported']), 'unknown')
})

test('host renderer evidence accepts only the closed renderer source set and preserves zero counters', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()

    assert.equal(
        collector.recordRenderStats({
            source: 'renderer-host',
            backend: 'webgl2',
            timestampMs: 0,
            drawCalls: 0,
            triangles: 0,
            gpu: { status: 'not-provided' },
        }),
        true
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'private-renderer-source',
            backend: 'webgl2',
            timestampMs: 0,
            drawCalls: 1,
            gpu: { status: 'not-provided' },
        }),
        false
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'renderer-host',
            backend: 'canvas2d',
            timestampMs: 0,
            drawCalls: 0,
            gpu: { status: 'not-provided' },
        }),
        true
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'renderer-host',
            backend: 'canvas2d',
            timestampMs: 0,
            gpu: {
                status: 'measured',
                timeMs: 1,
                source: 'host-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        }),
        false
    )
    assert.equal(
        collector.recordRenderStats({
            source: 'three-renderer-info',
            backend: 'canvas2d',
            timestampMs: 0,
            drawCalls: 1,
            gpu: { status: 'not-provided' },
        }),
        false
    )

    const renderer = collector.stop().hostEvidence.renderer
    assert.equal(renderer.acceptedSampleCount, 2)
    assert.equal(renderer.rejectedSampleCount, 3)
    assert.equal(renderer.evidenceSampleCount, 2)
    assert.deepEqual(renderer.backends, ['canvas2d', 'webgl2'])
    assert.deepEqual(renderer.evidenceBackends, ['canvas2d', 'webgl2'])
    assert.equal(renderer.drawCalls.p95, 0)
    assert.equal(renderer.triangles.p95, 0)
})

test('unsupported observers remain unknown evidence, not numeric zero', () => {
    const runtime = new FakeRuntime({
        capabilities: {
            'long-animation-frame': 'unsupported',
            longtask: 'unknown',
            event: 'unknown',
        },
    })
    const collector = new AnimationCollector({ runtime }).start()
    runtime.tick(0)
    const snapshot = collector.stop()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })

    assert.equal(snapshot.longAnimationFrames.capability.state, 'unsupported')
    assert.equal(snapshot.longTasks.capability.state, 'unknown')
    assert.equal(snapshot.longAnimationFrames.totalObservedCount, null)
    assert.equal(snapshot.longTasks.totalObservedCount, null)
    assert.equal(snapshot.eventTiming.totalObservedCount, null)
    assert.equal(snapshot.eventTiming.presentationDelay, null)
    assert.equal(snapshot.capabilities.longtask, null)
    assert.equal(snapshot.capabilities.event, null)
    assert.equal(snapshot.longAnimationFrames.paintTiming.paintTimeCapability.state, 'unsupported')
    assert.equal(snapshot.longAnimationFrames.paintTiming.presentationTimeCapability.state, 'unsupported')
    assert.equal(snapshot.capabilities.longAnimationFramePaintTime, false)
    assert.equal(snapshot.capabilities.longAnimationFramePresentationTime, false)
    assert.equal(Object.keys(snapshot.coverage).length, 12)

    for (const metricName of ['longAnimationFrameCount', 'longAnimationFrameDurationMs']) {
        const metrics = summary.metrics.filter(metric => metric.name === metricName)
        assert.ok(metrics.length > 0)
        for (const metric of metrics) {
            assert.equal(metric.value, null)
            assert.equal(metric.samples, null)
            assert.equal(metric.status, 'unsupported')
        }
    }
    for (const metricName of ['longTaskCount', 'longTaskDurationMs']) {
        const metrics = summary.metrics.filter(metric => metric.name === metricName)
        assert.ok(metrics.length > 0)
        for (const metric of metrics) {
            assert.equal(metric.value, null)
            assert.equal(metric.samples, null)
            assert.equal(metric.status, 'unknown')
        }
    }
    assert.deepEqual(summary.coverage.mainThread, {
        status: 'not-observed',
        evidenceLevel: 'unsupported-or-unknown',
    })
})

test('RUM coverage distinguishes unsupported wire observers from families absent from v1', () => {
    const runtime = new FakeRuntime({
        capabilities: {
            'long-animation-frame': 'unsupported',
            longtask: 'unsupported',
            event: 'unsupported',
            resource: 'unsupported',
        },
    })
    const snapshot = new AnimationCollector({ runtime }).start().stop()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })

    assert.deepEqual(summary.coverage.mainThread, {
        status: 'unsupported',
        evidenceLevel: 'unsupported-or-unknown',
    })
    assert.deepEqual(summary.coverage.renderingPipeline, {
        status: 'unsupported',
        evidenceLevel: 'unsupported-or-unknown',
    })
    assert.deepEqual(summary.coverage.resourcesMedia, {
        status: 'not-instrumented',
        evidenceLevel: 'unsupported-or-unknown',
    })
    assert.equal(summary.coverage.userOutcome.status, 'not-observed')
})

test('every completed RUM window projects supported-zero LoAF and Long Task aggregates without distributions', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    runtime.advance(1_000)

    const running = toAnimationRumSummary(collector.snapshot(), {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const snapshot = collector.stop()
    const completed = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const findMetric = (summary, name, stat) => summary.metrics.find(metric => metric.name === name && metric.stat === stat)

    for (const [name, stat] of [
        ['longAnimationFrameCount', 'count'],
        ['longAnimationFrameDurationMs', 'sum'],
        ['longTaskCount', 'count'],
        ['longTaskDurationMs', 'sum'],
    ]) {
        assert.deepEqual(
            [findMetric(running, name, stat).value, findMetric(running, name, stat).samples, findMetric(running, name, stat).status],
            [0, 0, 'measured']
        )
        assert.deepEqual(
            [findMetric(completed, name, stat).value, findMetric(completed, name, stat).samples, findMetric(completed, name, stat).status],
            [0, 0, 'measured']
        )
    }

    for (const [name, stat] of [
        ['longAnimationFrameDurationMs', 'p95'],
        ['longAnimationFrameBlockingMs', 'p95'],
        ['longAnimationFrameStyleLayoutTailMs', 'p95'],
        ['longTaskDurationMs', 'p95'],
        ['longTaskDurationMs', 'max'],
    ]) {
        const distribution = findMetric(completed, name, stat)
        assert.deepEqual([distribution.value, distribution.samples, distribution.status], [null, null, 'not-observed'])
    }
    assert.equal(running.coverage.mainThread.status, 'measured')
    assert.equal(completed.coverage.mainThread.status, 'measured')
})

test('late-start buffered replay excludes pre-capture entries and clips entries crossing capture start', () => {
    const runtime = new FakeRuntime()
    runtime.time = 100
    const collector = new AnimationCollector({ runtime, maxSignalEntries: 8 }).start()
    const entries = [
        { startTime: 0, duration: 50 },
        { startTime: 80, duration: 40 },
        { startTime: 110, duration: 30 },
    ]
    runtime.emit('long-animation-frame', [
        { ...entries[0], blockingDuration: 10, styleAndLayoutStart: 20 },
        { ...entries[1], blockingDuration: 12, styleAndLayoutStart: 105 },
        { ...entries[2], blockingDuration: 8, styleAndLayoutStart: 125 },
    ])
    runtime.emit('longtask', entries)
    runtime.emit('event', [
        { ...entries[0], processingStart: 10, processingEnd: 30 },
        { ...entries[1], processingStart: 90, processingEnd: 110 },
        { ...entries[2], processingStart: 115, processingEnd: 125 },
    ])
    const snapshot = collector.stop()

    for (const signal of [snapshot.longAnimationFrames, snapshot.longTasks, snapshot.eventTiming]) {
        assert.equal(signal.totalObservedCount, 2)
        assert.equal(signal.totalDurationMs, 50)
        assert.equal(signal.duration.total, 50)
        assert.equal(signal.duration.p50, 25)
    }
    assert.equal(snapshot.longAnimationFrames.blockingDuration.count, 1)
    assert.equal(snapshot.longAnimationFrames.styleAndLayoutTailDuration.count, 2)
    assert.equal(snapshot.longAnimationFrames.styleAndLayoutTailDuration.total, 30)
    assert.equal(snapshot.eventTiming.inputDelay.total, 5)
    assert.equal(snapshot.eventTiming.processingDuration.total, 20)
    assert.equal(snapshot.eventTiming.presentationDelay.total, 25)
})

test('snapshot and stop drain queued performance entries before reporting and interaction finalization', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collector.beginInteraction('drag', 'queued-signals')
    runtime.queue('long-animation-frame', [{ startTime: 10, duration: 60, blockingDuration: 10, styleAndLayoutStart: 40 }])
    runtime.queue('longtask', [{ startTime: 10, duration: 60 }])
    runtime.queue('event', [{ startTime: 10, duration: 60, processingStart: 20, processingEnd: 40 }])
    runtime.advance(100)

    const live = collector.snapshot()
    assert.equal(runtime.pendingEntries.size, 0)
    assert.equal(live.longAnimationFrames.totalObservedCount, 1)
    assert.equal(live.longTasks.totalObservedCount, 1)
    assert.equal(live.eventTiming.totalObservedCount, 1)
    assert.equal(live.interactions.active[0].performance.longAnimationFrames.overlapCount, 1)
    assert.equal(live.interactions.active[0].performance.longTasks.overlapCount, 1)
    assert.equal(live.interactions.active[0].performance.eventTiming.overlapCount, 1)

    runtime.queue('long-animation-frame', [{ startTime: 110, duration: 60, blockingDuration: 12, styleAndLayoutStart: 140 }])
    runtime.queue('longtask', [{ startTime: 110, duration: 60 }])
    runtime.queue('event', [{ startTime: 110, duration: 60, processingStart: 120, processingEnd: 145 }])
    runtime.advance(100)
    const final = collector.stop()
    assert.equal(runtime.pendingEntries.size, 0)
    assert.equal(final.longAnimationFrames.totalObservedCount, 2)
    assert.equal(final.longTasks.totalObservedCount, 2)
    assert.equal(final.eventTiming.totalObservedCount, 2)
    assert.equal(final.interactions.recent[0].outcome, 'abandoned')
    assert.equal(final.interactions.recent[0].performance.longAnimationFrames.overlapCount, 2)
    assert.equal(final.interactions.recent[0].performance.longTasks.overlapCount, 2)
    assert.equal(final.interactions.recent[0].performance.eventTiming.overlapCount, 2)
})

test('collector isolates host drain failures at snapshot and stop boundaries', () => {
    const collector = new AnimationCollector({ runtime: new FakeRuntime({ drainError: true }) }).start()
    assert.doesNotThrow(() => collector.snapshot())
    assert.doesNotThrow(() => collector.stop())
})

test('state transitions are strict while stop and cleanup are idempotent', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime })
    assert.throws(() => collector.snapshot(), AnimationStateError)
    collector.start()
    assert.throws(() => collector.start(), AnimationStateError)
    const active = collector.beginInteraction('lifecycle', 'mount')
    const first = collector.stop()
    const second = collector.stop()

    assert.notStrictEqual(first, second)
    assert.deepEqual(first, second)
    assert.equal(first.monitorOverhead.reportBuildDuration.count, 1)
    assert.equal(first.interactions.abandonedCount, 1)
    assert.equal(active.end().outcome, 'abandoned')
    first.coverage.userOutcome.status = 'unsupported'
    first.hostEvidence.framework.phases.mount = 999
    const third = collector.snapshot()
    assert.equal(third.coverage.userOutcome.status, second.coverage.userOutcome.status)
    assert.equal(third.hostEvidence.framework.phases.mount, second.hostEvidence.framework.phases.mount)
    assert.equal(runtime.frames.size, 0)
    assert.equal(runtime.observerCount, 0)
    assert.equal(runtime.visibilityListeners.size, 0)
    assert.equal(runtime.motionListeners.size, 0)
    collector.destroy()
    collector.destroy()
    assert.equal(collector.state, 'destroyed')
    assert.throws(() => collector.snapshot(), AnimationStateError)
})

test('report-build coverage reflects the first sample and same-snapshot ring truncation', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime, maxSignalEntries: 1 }).start()
    const first = collector.snapshot()
    assert.equal(first.monitorOverhead.reportBuildRetainedCount, 1)
    assert.equal(first.monitorOverhead.reportBuildDroppedSampleCount, 0)
    assert.equal(first.coverage.monitorOverhead.status, 'measured')

    const second = collector.snapshot()
    assert.equal(second.monitorOverhead.reportBuildRetainedCount, 1)
    assert.equal(second.monitorOverhead.reportBuildDroppedSampleCount, 1)
    assert.equal(second.coverage.monitorOverhead.status, 'partial')
    collector.destroy()
})

test('capture IDs remain collision-resistant across collectors with the same monotonic clock', () => {
    const first = new AnimationCollector({ runtime: new FakeRuntime() }).start().stop().captureId
    const second = new AnimationCollector({ runtime: new FakeRuntime() }).start().stop().captureId
    assert.notEqual(first, second)
    assert.match(first, /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/)
    assert.match(second, /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/)
})

test('default integration is local-only; opted-in sticky RUM emits one closed redacted report', () => {
    const localRuntime = new FakeRuntime()
    const localTransport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const local = new AnimationIntegration({ runtime: localRuntime })
    local.setup(localTransport)
    collectFrames(localRuntime, [16, 16])
    local.stop()
    local.destroy()
    assert.equal(localTransport.reports.length, 0)

    const runtime = new FakeRuntime()
    const transport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const integration = new AnimationIntegration({
        runtime,
        explicitRefreshHz: 60,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'stable-device-bucket', policyVersion: 3 },
        context: {
            routeKey: 'home.feed',
            release: '2026.08.24',
            dist: 'web',
            environment: 'production',
            sdkVersion: '1.0.0',
            runtimeFamily: 'react',
        },
    })
    const teardown = integration.setup(transport)
    const interaction = integration.beginInteraction('scroll', 'https://private.example/users/42#card')
    collectFrames(runtime, [16, 40])
    runtime.emit('longtask', [{ startTime: 10, duration: 80 }])
    runtime.advance(50)
    interaction.end()
    integration.stop()
    integration.flush()
    teardown()

    assert.equal(transport.reports.length, 1)
    const report = transport.reports[0]
    const rootKeys = [
        'event_type',
        'message',
        'contractVersion',
        'snapshotSchemaVersion',
        'eventId',
        'captureId',
        'capturedAt',
        'release',
        'dist',
        'environment',
        'sdkVersion',
        'monitorVersion',
        'sampleRate',
        'samplingPolicyVersion',
        'context',
        'capabilities',
        'coverage',
        'metrics',
    ].sort()
    assert.deepEqual(Object.keys(report).sort(), rootKeys)
    assert.equal(report.event_type, 'animation_rum')
    assert.equal(report.message, '')
    assert.equal(report.contractVersion, 1)
    assert.equal(report.snapshotSchemaVersion, 1)
    assert.equal(report.samplingPolicyVersion, 3)
    assert.match(report.capturedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/)
    assert.match(report.eventId, /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/)
    assert.equal(Object.keys(report.coverage).length, 12)
    assert.equal(Object.keys(report.capabilities).length, 13)
    assert.equal(report.context.windowDurationMs, 106)
    assert.equal(report.context.windowDurationCapped, false)
    assert.ok(report.metrics.length > 0 && report.metrics.length <= 128)
    assert.ok(report.metrics.some(metric => metric.name === 'longTaskDurationMs' && metric.stat === 'sum' && metric.value === 80))
    assert.ok(report.metrics.some(metric => metric.name === 'longAnimationFrameStyleLayoutTailMs' && metric.stat === 'p95'))
    assert.equal(
        report.metrics.some(metric => metric.name === 'longAnimationFrameStyleLayoutMs'),
        false
    )
    assert.ok(report.metrics.some(metric => metric.name === 'reportBuildSelfTimeMs' && metric.stat === 'p95'))
    for (const item of report.metrics) {
        assert.deepEqual(Object.keys(item).sort(), ['family', 'name', 'samples', 'stat', 'status', 'unit', 'value'])
    }
    const forbidden = new Set([
        'user',
        'userid',
        'useremail',
        'email',
        'url',
        'href',
        'selector',
        'frames',
        'rawframes',
        'entries',
        'scripts',
        'metadata',
        'snapshot',
        'events',
    ])
    const visit = value => {
        if (!value || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value)) {
            assert.equal(forbidden.has(key.toLowerCase()), false, `forbidden key ${key}`)
            visit(child)
        }
    }
    visit(report)
    assert.equal(JSON.stringify(report).includes('private.example'), false)
    assert.equal(JSON.stringify(report).includes('data-user'), false)
})

test('optional integration remains idle and no-ops when browser frame collection is unsupported', () => {
    const runtime = new FakeRuntime({ frameCapability: 'unsupported' })
    const transport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const integration = new AnimationIntegration({
        runtime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'unsupported-frame-page' },
    })

    assert.doesNotThrow(() => integration.setup(transport))
    assert.equal(integration.collector.state, 'idle')
    assert.equal(integration.start(), false)
    assert.doesNotThrow(() => integration.flush())
    assert.equal(integration.stop(), null)
    assert.doesNotThrow(() => integration.destroy())
    assert.equal(integration.collector.state, 'destroyed')
    assert.equal(transport.reports.length, 0)
})

test('integration setup attaches pre-started and pre-stopped collectors without a second start', () => {
    const runningRuntime = new FakeRuntime()
    const runningTransport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const running = new AnimationIntegration({
        runtime: runningRuntime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'pre-started-page' },
    })
    assert.equal(running.start(), true)
    assert.equal(running.start(), true)
    collectFrames(runningRuntime, [16])
    assert.doesNotThrow(() => running.setup(runningTransport))
    assert.equal(running.collector.state, 'running')
    assert.ok(running.stop())
    assert.equal(runningTransport.reports.length, 1)
    assert.equal(running.start(), false)
    running.destroy()

    const stoppedRuntime = new FakeRuntime()
    const stoppedTransport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const stopped = new AnimationIntegration({
        runtime: stoppedRuntime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'pre-stopped-page' },
    })
    assert.equal(stopped.start(), true)
    collectFrames(stoppedRuntime, [16])
    const stoppedSnapshot = stopped.stop()
    assert.equal(stoppedTransport.reports.length, 0)
    assert.doesNotThrow(() => stopped.setup(stoppedTransport))
    assert.equal(stopped.collector.state, 'stopped')
    assert.equal(stoppedTransport.reports.length, 1)
    assert.equal(stoppedTransport.reports[0].captureId, stoppedSnapshot.captureId)
    stopped.destroy()
})

test('deterministic sampling is sticky and projection validates explicit sampling metadata', () => {
    const first = deterministicAnimationRumSample('same-key', 0.37, 'v1')
    assert.equal(deterministicAnimationRumSample('same-key', 0.37, 'v1'), first)
    assert.equal(deterministicAnimationRumSample('same-key', 0, 'v1'), false)
    assert.equal(deterministicAnimationRumSample('same-key', 1, 'v1'), true)

    const runtime = new FakeRuntime()
    const snapshot = new AnimationCollector({ runtime }).start().stop()
    assert.throws(
        () => toAnimationRumSummary(snapshot, { capturedAtEpochMs: runtime.wallNow(), sampleRate: 0, samplingPolicyVersion: 1 }),
        /sampleRate/
    )
})

test('RUM projection rebuilds nested allowlists and rejects runtime-family escape values', () => {
    const runtime = new FakeRuntime()
    const snapshot = new AnimationCollector({ runtime }).start().stop()
    snapshot.capabilities.privateUrl = 'https://private.example/capability'
    snapshot.capabilities.longtask = 'https://private.example/not-a-boolean'
    snapshot.capabilities['long-animation-frame'] = false
    snapshot.capabilities.documentAnimationsInspection = true
    snapshot.capabilities.webVitalsSoftNavigation = true
    snapshot.coverage.privateUrl = {
        status: 'measured',
        evidenceLevel: 'runtime-observation',
        secret: 'https://private.example/coverage',
    }
    snapshot.coverage.userOutcome.privateUrl = 'https://private.example/nested'
    snapshot.visibility.current = 'https://private.example/visibility'

    const report = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal(Object.keys(report.capabilities).length, 13)
    assert.equal(Object.keys(report.coverage).length, 12)
    assert.deepEqual(Object.keys(report.coverage.userOutcome).sort(), ['evidenceLevel', 'status'])
    assert.equal(report.capabilities['long-animation-frame'], true)
    assert.equal(report.capabilities.longtask, true)
    assert.equal(report.capabilities.documentAnimationsInspection, null)
    assert.equal(report.capabilities.webVitalsSoftNavigation, null)
    assert.equal(report.capabilities.visibilityLifecycle, null)
    assert.equal(report.context.visibilityState, 'unknown')
    assert.doesNotMatch(JSON.stringify(report), /private\.example|privateUrl|secret/)
    assert.throws(
        () =>
            toAnimationRumSummary(snapshot, {
                capturedAtEpochMs: runtime.wallNow(),
                sampleRate: 1,
                samplingPolicyVersion: 1,
                runtimeFamily: 'https://private.example/runtime',
            }),
        /runtimeFamily/
    )
})

test('animation RUM v1 keeps its exact closed set of 32 aggregate metric tuples', () => {
    const runtime = new FakeRuntime()
    const snapshot = new AnimationCollector({ runtime }).start().stop()
    const report = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const tuples = report.metrics.map(metric => `${metric.family}|${metric.name}|${metric.stat}|${metric.unit}`).sort()

    assert.equal(tuples.length, 32)
    assert.deepEqual(tuples, [
        'frameCadence|frameDurationMs|max|ms',
        'frameCadence|frameDurationMs|p50|ms',
        'frameCadence|frameDurationMs|p75|ms',
        'frameCadence|frameDurationMs|p95|ms',
        'frameCadence|frameDurationMs|p99|ms',
        'frameCadence|inferredRefreshHz|latest|hz',
        'frameCadence|jankBurstCount|count|count',
        'frameCadence|longestSlowFrameRun|max|frames',
        'frameCadence|missedFrameOpportunities|sum|frames',
        'frameCadence|slowFrameRate|ratio|ratio',
        'frameCadence|targetFrameMs|latest|ms',
        'mainThread|longAnimationFrameBlockingMs|p95|ms',
        'mainThread|longAnimationFrameCount|count|count',
        'mainThread|longAnimationFrameDurationMs|p95|ms',
        'mainThread|longAnimationFrameDurationMs|sum|ms',
        'mainThread|longTaskCount|count|count',
        'mainThread|longTaskDurationMs|max|ms',
        'mainThread|longTaskDurationMs|p95|ms',
        'mainThread|longTaskDurationMs|sum|ms',
        'monitorOverhead|callbackCount|count|count',
        'monitorOverhead|callbackSelfTimeRatio|ratio|ratio',
        'monitorOverhead|reportBuildSelfTimeMs|p95|ms',
        'renderingPipeline|longAnimationFrameStyleLayoutTailMs|p95|ms',
        'renderingPipeline|presentationDelayMs|p95|ms',
        'userOutcome|abandonedInteractions|count|count',
        'userOutcome|cancelledInteractions|count|count',
        'userOutcome|completedInteractions|count|count',
        'userOutcome|eventTimingDurationMs|p95|ms',
        'userOutcome|inputDelayMs|p95|ms',
        'userOutcome|interactionCount|count|count',
        'userOutcome|interactionDurationMs|p95|ms',
        'userOutcome|processingDurationMs|p95|ms',
    ])
})

test('RUM percentile sample counts and report-build status reflect their retained bounded rings', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({
        runtime,
        explicitRefreshHz: 60,
        maxInteractions: 1,
        maxSignalEntries: 1,
    }).start()
    const first = collector.beginInteraction('pointer', 'first')
    runtime.advance(10)
    first.end()
    const second = collector.beginInteraction('pointer', 'second')
    runtime.advance(20)
    second.end()
    collector.snapshot()
    const snapshot = collector.snapshot()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const interactionP95 = summary.metrics.find(metric => metric.name === 'interactionDurationMs' && metric.stat === 'p95')
    const interactionCount = summary.metrics.find(metric => metric.name === 'interactionCount')
    const reportBuild = summary.metrics.find(metric => metric.name === 'reportBuildSelfTimeMs')
    assert.equal(interactionCount.value, 2)
    assert.equal(interactionP95.samples, 1)
    assert.equal(interactionP95.status, 'partial')
    assert.equal(reportBuild.samples, 1)
    assert.equal(reportBuild.status, 'partial')
    collector.destroy()
})

test('RUM keeps streaming totals measured while truncated ring distributions remain partial', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({
        runtime,
        explicitRefreshHz: 60,
        maxFrames: 1,
        maxInteractions: 1,
        maxSignalEntries: 1,
    }).start()
    collectFrames(runtime, [40, 45])
    const completed = collector.beginInteraction('pointer', 'completed')
    runtime.advance(10)
    completed.end()
    const cancelled = collector.beginInteraction('pointer', 'cancelled')
    runtime.advance(20)
    cancelled.cancel()
    runtime.emit('long-animation-frame', [
        { startTime: 5, duration: 60, blockingDuration: 10, styleAndLayoutStart: 30 },
        { startTime: 50, duration: 60, blockingDuration: 12, styleAndLayoutStart: 80 },
    ])
    runtime.emit('longtask', [
        { startTime: 5, duration: 60 },
        { startTime: 45, duration: 70 },
    ])
    const snapshot = collector.stop()
    const summary = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const findMetric = (name, stat) => summary.metrics.find(metric => metric.name === name && metric.stat === stat)

    assert.equal(findMetric('jankBurstCount', 'count').status, 'partial')
    assert.equal(findMetric('missedFrameOpportunities', 'sum').status, 'partial')

    assert.deepEqual(
        [findMetric('longAnimationFrameCount', 'count').value, findMetric('longAnimationFrameCount', 'count').status],
        [2, 'measured']
    )
    assert.deepEqual(
        [findMetric('longAnimationFrameDurationMs', 'sum').value, findMetric('longAnimationFrameDurationMs', 'sum').status],
        [120, 'measured']
    )
    assert.equal(findMetric('longAnimationFrameDurationMs', 'p95').status, 'partial')
    assert.equal(findMetric('longAnimationFrameDurationMs', 'p95').samples, 1)

    assert.deepEqual([findMetric('longTaskCount', 'count').value, findMetric('longTaskCount', 'count').status], [2, 'measured'])
    assert.deepEqual([findMetric('longTaskDurationMs', 'sum').value, findMetric('longTaskDurationMs', 'sum').status], [130, 'measured'])
    assert.equal(findMetric('longTaskDurationMs', 'p95').status, 'partial')
    assert.equal(findMetric('longTaskDurationMs', 'max').status, 'partial')

    assert.deepEqual([findMetric('interactionCount', 'count').value, findMetric('interactionCount', 'count').status], [2, 'measured'])
    assert.deepEqual(
        [findMetric('completedInteractions', 'count').value, findMetric('completedInteractions', 'count').status],
        [1, 'measured']
    )
    assert.deepEqual(
        [findMetric('cancelledInteractions', 'count').value, findMetric('cancelledInteractions', 'count').status],
        [1, 'measured']
    )
    assert.deepEqual(
        [findMetric('abandonedInteractions', 'count').value, findMetric('abandonedInteractions', 'count').status],
        [0, 'measured']
    )
    assert.equal(findMetric('interactionDurationMs', 'p95').status, 'partial')
    assert.equal(findMetric('interactionDurationMs', 'p95').samples, 1)
    assert.equal(summary.coverage.frameCadence.status, 'partial')
    assert.equal(summary.coverage.mainThread.status, 'partial')
    assert.equal(summary.coverage.userOutcome.status, 'partial')
})

test('RUM window duration is bounded and callback self-time ratio uses the complete capture aggregate', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    runtime.emit('long-animation-frame', [{ startTime: 0, duration: 80 }])
    runtime.emit('longtask', [{ startTime: 0, duration: 80 }])
    runtime.advance(1_000)
    const snapshot = collector.stop()
    snapshot.monitorOverhead.callbackCount = 10
    snapshot.monitorOverhead.retainedCount = 1
    snapshot.monitorOverhead.droppedSampleCount = 9
    snapshot.monitorOverhead.totalCallbackDurationMs = 25

    const uncapped = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const callbackRatio = uncapped.metrics.find(metric => metric.name === 'callbackSelfTimeRatio')
    assert.equal(uncapped.context.windowDurationMs, 1_000)
    assert.equal(uncapped.context.windowDurationCapped, false)
    assert.equal(callbackRatio.stat, 'ratio')
    assert.equal(callbackRatio.value, 0.025)
    assert.equal(callbackRatio.samples, 10)
    assert.equal(callbackRatio.status, 'measured')

    snapshot.elapsedMs = ANIMATION_RUM_MAX_WINDOW_DURATION_MS + 1_000
    const capped = toAnimationRumSummary(snapshot, {
        capturedAtEpochMs: runtime.wallNow(),
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    const cappedCallbackRatio = capped.metrics.find(metric => metric.name === 'callbackSelfTimeRatio')
    const cappedLoafSum = capped.metrics.find(metric => metric.name === 'longAnimationFrameDurationMs' && metric.stat === 'sum')
    const cappedLongTaskSum = capped.metrics.find(metric => metric.name === 'longTaskDurationMs' && metric.stat === 'sum')
    assert.equal(capped.context.windowDurationMs, ANIMATION_RUM_MAX_WINDOW_DURATION_MS)
    assert.equal(capped.context.windowDurationCapped, true)
    assert.equal(cappedCallbackRatio.status, 'partial')
    assert.equal(cappedLoafSum.status, 'partial')
    assert.equal(cappedLongTaskSum.status, 'partial')
    assert.equal(capped.coverage.mainThread.status, 'partial')
    assert.equal(capped.coverage.monitorOverhead.status, 'partial')

    snapshot.elapsedMs = Number.POSITIVE_INFINITY
    assert.throws(
        () =>
            toAnimationRumSummary(snapshot, {
                capturedAtEpochMs: runtime.wallNow(),
                sampleRate: 1,
                samplingPolicyVersion: 1,
            }),
        /elapsedMs/
    )
})

test('collector keeps total callback self time when its diagnostic sample ring truncates', () => {
    class CostRuntime extends FakeRuntime {
        now() {
            const value = this.time
            this.time += 1
            return value
        }
    }

    const runtime = new CostRuntime()
    const collector = new AnimationCollector({ runtime, maxSignalEntries: 1 }).start()
    collectFrames(runtime, [16, 16])
    const snapshot = collector.stop()
    assert.ok(snapshot.monitorOverhead.droppedSampleCount > 0)
    assert.ok(snapshot.monitorOverhead.totalCallbackDurationMs > snapshot.monitorOverhead.duration.total)
})

test('hidden/pagehide enqueues once before lifecycle flush without stopping BFCache-capable local capture', () => {
    const runtime = new FakeRuntime()
    const transport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const integration = new AnimationIntegration({
        runtime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'lifecycle-page' },
    })
    integration.setup(transport)
    collectFrames(runtime, [16, 24])
    runtime.emitLifecycle({ type: 'hidden' })
    assert.equal(transport.reports.length, 1)
    assertSupportedZeroSignalRum(transport.reports[0])
    assert.equal(integration.collector.state, 'running')
    runtime.emitLifecycle({ type: 'pagehide', persisted: true })
    assert.equal(transport.reports.length, 1)
    assert.equal(integration.collector.state, 'running')
    integration.destroy()

    const directRuntime = new FakeRuntime()
    const directTransport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const direct = new AnimationIntegration({
        runtime: directRuntime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'direct-pagehide' },
    })
    direct.setup(directTransport)
    collectFrames(directRuntime, [16])
    directRuntime.emitLifecycle({ type: 'pagehide', persisted: false })
    assert.equal(directTransport.reports.length, 1)
    assertSupportedZeroSignalRum(directTransport.reports[0])
    assert.equal(direct.collector.state, 'running')
    direct.destroy()
})

test('integration flush waits for a finalized snapshot and emits once after stop', () => {
    const runtime = new FakeRuntime()
    const transport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const integration = new AnimationIntegration({
        runtime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'manual-flush' },
    })
    integration.setup(transport)
    collectFrames(runtime, [16, 24])
    integration.flush()
    assert.equal(transport.reports.length, 0)
    assert.equal(integration.collector.state, 'running')
    runtime.tick(32)
    assert.equal(integration.snapshot().frames.totalObservedCount, 3)
    integration.stop()
    assert.equal(transport.reports.length, 1)
    assertSupportedZeroSignalRum(transport.reports[0])
    integration.flush()
    assert.equal(transport.reports.length, 1)
    assert.equal(integration.collector.state, 'stopped')
    integration.destroy()
})

test('recommendations are evidence-specific, have no score, and require adapters for hidden/reduced-motion violations', () => {
    const runtime = new FakeRuntime({ reducedMotion: true })
    const collector = new AnimationCollector({ runtime, explicitRefreshHz: 60 }).start()
    collectFrames(runtime, [16, 40, 45])
    runtime.emit('longtask', [{ startTime: 10, duration: 80 }])
    runtime.emit('long-animation-frame', [{ startTime: 10, duration: 70, blockingDuration: 20, styleAndLayoutStart: 50 }])
    runtime.emit('event', [{ startTime: 20, duration: 90, processingStart: 50, processingEnd: 80 }])
    const snapshot = collector.stop()

    const withoutAdapters = recommendAnimationImprovements(snapshot)
    assert.equal(
        withoutAdapters.some(item => item.id.includes('hidden')),
        false
    )
    assert.equal(
        withoutAdapters.some(item => item.id.includes('reduced-motion')),
        false
    )
    assert.equal(
        withoutAdapters.some(item => item.id.startsWith('event-')),
        false,
        'the default Event Timing phase investigation budget is 100ms'
    )
    snapshot.monitorOverhead.callbackCount = 50
    snapshot.monitorOverhead.totalCallbackDurationMs = snapshot.elapsedMs * 0.02
    const recommendations = recommendAnimationImprovements(snapshot, {
        eventPhaseBudgetMs: 10,
        adapterEvidence: {
            hiddenWorkSamples: { value: 2, samples: 10 },
            reducedMotionViolations: { value: 1, samples: 4 },
        },
    })
    const ids = recommendations.map(item => item.id)
    assert.ok(ids.includes('frame-tail-and-bursts'))
    assert.ok(ids.includes('long-task-main-thread'))
    assert.ok(ids.includes('loaf-rendering-tail'))
    assert.ok(ids.includes('event-input-delay'))
    assert.ok(ids.includes('event-processing-delay'))
    assert.ok(ids.includes('event-presentation-delay'))
    assert.ok(ids.includes('hidden-work'))
    assert.ok(ids.includes('reduced-motion-violations'))
    assert.ok(ids.includes('monitor-callback-overhead'))
    assert.equal(recommendations.find(item => item.id === 'frame-tail-and-bursts').target.kind, 'project-budget')
    assert.equal(recommendations.find(item => item.id === 'frame-tail-and-bursts').confidence, 'low')
    assert.equal(recommendations.find(item => item.id === 'loaf-rendering-tail').metric.name, 'longAnimationFrameStyleLayoutTailMs.p95')
    assert.match(recommendations.find(item => item.id === 'loaf-rendering-tail').why, /subsequent rendering work/)
    assert.equal(recommendations.find(item => item.id === 'hidden-work').target.kind, 'project-budget')
    assert.equal(recommendations.find(item => item.id === 'monitor-callback-overhead').target.value, 0.01)
    assert.equal(recommendations.find(item => item.id === 'monitor-callback-overhead').target.kind, 'project-budget')
    for (const item of recommendations) {
        assert.equal(item.After, 'proposed')
        assert.equal('score' in item, false)
        assert.ok(item.rerunProtocol.length > 0)
        assert.ok(item.regressionChecks.length > 0)
    }
})

test('element selection is a parallel native sidecar with bounded direct evidence and optional multi-adapter enrichment', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 16, 24])
    const listeners = new Map()
    const animation = {
        playState: 'running',
        pending: false,
        playbackRate: 1,
        effect: {
            getTiming: () => ({ duration: 240, delay: 20, iterations: 1 }),
            getKeyframes: () => [{ transform: 'translateX(20px)', opacity: 0.5, width: '20px' }],
        },
    }
    Object.defineProperty(animation, 'constructor', { value: { name: 'CSSAnimation' } })
    const target = {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 800,
        height: 400,
        ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
        getAttribute: name => (name === 'role' ? 'img' : name === 'id' ? 'private-id' : null),
        getAnimations: options => {
            assert.deepEqual(options, { subtree: true })
            return [animation]
        },
        getBoundingClientRect: () => ({ left: 20, top: 30, right: 420, bottom: 230, width: 400, height: 200 }),
        addEventListener(type, listener) {
            const entries = listeners.get(type) ?? new Set()
            entries.add(listener)
            listeners.set(type, entries)
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener)
        },
    }
    const registry = createAnimationTargetAdapterRegistry('react-three', '1.2.0')
    let registryInspectionContext = null
    const unregisterAdapter = registry.register(target, context => {
        registryInspectionContext = context
        return {
            inventory: { uiFrameworks: ['react'], metaRuntimes: ['next'], renderers: ['webgl'], motionEngines: ['gsap'] },
            owners: [
                {
                    relation: 'framework-owner',
                    framework: 'react',
                    label: 'HeroCanvas',
                    source: { file: 'src/HeroCanvas.tsx', line: 42 },
                },
            ],
            renderer: {
                family: 'webgl',
                capability: { state: 'supported', observed: true, buffered: false },
                metrics: { drawCallsP95: 12, trianglesP95: 2_000, gpuFrameMsP95: -1 },
            },
        }
    })

    const before = collector.snapshot()
    const selection = collector.selectElement(target, { mode: 'subtree', adapters: [registry.adapter] })
    const direct = selection.snapshot()
    assert.equal(Object.hasOwn(direct, 'frameworkScopes'), false)
    assert.equal(Object.hasOwn(direct, 'videoPresentations'), false)
    assert.equal(direct.state, 'selected')
    assert.equal(direct.localDescriptor.tagName, 'canvas')
    assert.equal(direct.localDescriptor.role, 'img')
    assert.equal(direct.direct.totalCount, 1)
    assert.equal(direct.direct.inspectedCount, 1)
    assert.equal(direct.direct.droppedAnimationCount, 0)
    assert.equal(direct.direct.propertyTruncated, false)
    assert.equal(direct.direct.cssAnimationCount, 1)
    assert.deepEqual(direct.direct.properties.compositorCandidate, ['opacity', 'transform'])
    assert.deepEqual(direct.direct.properties.layoutCandidate, ['width'])
    assert.equal(direct.geometry.backingPixelArea, 320_000)
    assert.equal(direct.geometry.backingScaleX, 2)
    assert.equal(direct.geometry.backingScaleY, 2)
    assert.equal(direct.geometry.backingAspectRatioMismatch, false)
    assert.equal(direct.geometry.effectivePixelRatio, 2)
    assert.equal(direct.geometry.resizeCount, 0)
    assert.equal(direct.geometry.cssResizeCount, 0)
    assert.equal(direct.geometry.backingResizeCount, 0)
    assert.deepEqual(direct.inventory.uiFrameworks, ['react'])
    assert.deepEqual(direct.inventory.renderers, ['canvas', 'webgl'])
    assert.deepEqual(direct.inventory.motionEngines, ['css', 'gsap'])
    assert.equal(direct.owners[0].label, 'HeroCanvas')
    assert.equal(direct.renderers[0].metrics.drawCallsP95, null)
    assert.equal(direct.renderers[0].metrics.gpuFrameMsP95, null)
    assert.deepEqual(direct.renderers[0].evidence.window, { startedAt: null, endedAt: null, durationMs: null })
    assert.equal(direct.renderers[0].evidence.acceptedSampleCount, null)
    assert.equal(direct.renderers[0].evidence.gpu.source, 'unknown')
    assert.equal(direct.renderers[0].evidence.gpu.rejectionReason, 'not-reported')
    assert.deepEqual(direct.adapterErrors, ['react-three:renderer-evidence-window-invalid'])
    assert.equal(registryInspectionContext.evidenceWindow.startedAt, direct.selectedAt)
    assert.ok(registryInspectionContext.evidenceWindow.endedAt <= direct.capturedAt)
    assert.equal(registryInspectionContext.evidenceWindow.relation, 'selection-window')
    assert.doesNotMatch(JSON.stringify(direct), /private-id/)

    target.getAnimations = () => Array.from({ length: 300 }, () => animation)
    const bounded = selection.snapshot()
    assert.equal(bounded.direct.totalCount, 300)
    assert.equal(bounded.direct.inspectedCount, 256)
    assert.equal(bounded.direct.droppedAnimationCount, 44)
    target.getAnimations = () => [animation]

    const scoped = selection.beginInteraction('transition', 'selected hero')
    assert.throws(() => selection.beginInteraction('custom', 'overlap'), /already has an active interaction/)
    runtime.tick(25)
    runtime.emit('longtask', [{ startTime: runtime.time - 20, duration: 20 }])
    const measurement = scoped.end()
    const completed = selection.snapshot()
    assert.equal(completed.activeInteractionId, null)
    assert.deepEqual(completed.correlated, measurement.performance)
    assert.equal(completed.correlationRelation, 'temporal-overlap')
    assert.equal(completed.correlatedDurationMs, measurement.durationMs)

    collectFrames(runtime, [20])
    const after = collector.snapshot()
    assert.equal(after.captureId, before.captureId)
    assert.ok(after.frames.totalObservedCount > before.frames.totalObservedCount)
    const rum = toAnimationRumSummary(after, {
        capturedAtEpochMs: 1_750_000_000_000,
        sampleRate: 1,
        samplingPolicyVersion: 1,
    })
    assert.equal('selectionId' in rum, false)
    assert.doesNotMatch(JSON.stringify(rum), /HeroCanvas|src\/HeroCanvas|selected hero/)

    target.isConnected = false
    assert.equal(selection.snapshot().state, 'disconnected')
    selection.clear()
    selection.clear()
    assert.equal(selection.state, 'cleared')
    assert.throws(() => selection.snapshot(), /cleared element selection/)
    assert.ok([...listeners.values()].every(entries => entries.size === 0))
    unregisterAdapter()
    unregisterAdapter()
    assert.equal(registry.adapter.canInspect(target), false)
    collector.destroy()
})

test('target adapter registry composes owner-scoped framework, Pixi, and renderer evidence without cross-owner disposal', () => {
    const target = {}
    const registry = createAnimationTargetAdapterRegistry('composite-host', '1')
    const frameworkOwner = {}
    const pixiOwner = {}
    const rendererOwner = {}
    const unregisterFramework = registry.register(
        target,
        () => ({ inventory: { uiFrameworks: ['react'] }, owners: [{ relation: 'framework-owner', framework: 'react' }] }),
        { owner: frameworkOwner }
    )
    const unregisterPixi = registry.register(
        target,
        () => ({
            inventory: { renderers: ['webgl'] },
            owners: [{ relation: 'renderer-host', label: 'Pixi sprite target-1' }],
        }),
        { owner: pixiOwner }
    )
    const unregisterRenderer = registry.register(
        target,
        () => ({
            renderer: { family: 'webgl', capability: { state: 'supported', observed: false, buffered: false } },
        }),
        { owner: rendererOwner }
    )
    registry.register(
        target,
        () => {
            throw new Error('isolated provider failure')
        },
        { owner: {} }
    )

    const composed = registry.adapter.inspect(target, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 1, endedAt: 2, relation: 'selection-window' },
    })
    assert.deepEqual(composed.inventory.uiFrameworks, ['react'])
    assert.deepEqual(composed.inventory.renderers, ['webgl'])
    assert.equal(composed.owners.length, 2)
    assert.equal(composed.renderers.length, 1)

    unregisterPixi()
    assert.equal(registry.adapter.inspect(target).owners.length, 1)
    unregisterFramework()
    assert.equal(registry.adapter.inspect(target).owners.length, 0)
    assert.equal(registry.adapter.inspect(target).renderers.length, 1)
    unregisterRenderer()
    assert.equal(registry.adapter.canInspect(target), true)
    registry.unregister(target)
    assert.equal(registry.adapter.canInspect(target), false)
})

test('target adapter owner replacement retires only the matching owner handle', () => {
    const target = {}
    const registry = createAnimationTargetAdapterRegistry('owner-replacement', '1')
    const firstOwner = {}
    const secondOwner = {}
    const stale = registry.register(target, () => ({ owners: [{ relation: 'renderer-host', label: 'stale' }] }), {
        owner: firstOwner,
    })
    const second = registry.register(target, () => ({ owners: [{ relation: 'renderer-host', label: 'second' }] }), {
        owner: secondOwner,
    })
    const replacement = registry.register(target, () => ({ owners: [{ relation: 'renderer-host', label: 'replacement' }] }), {
        owner: firstOwner,
    })

    stale()
    assert.deepEqual(
        registry.adapter.inspect(target).owners.map(owner => owner.label),
        ['replacement', 'second']
    )
    replacement()
    assert.deepEqual(
        registry.adapter.inspect(target).owners.map(owner => owner.label),
        ['second']
    )
    second()
    assert.equal(registry.adapter.canInspect(target), false)
})

test('target adapter owner composition is bounded per Element', () => {
    const target = {}
    const registry = createAnimationTargetAdapterRegistry('bounded-composition', '1')
    for (let index = 0; index < 16; index += 1) {
        registry.register(target, () => ({ owners: [] }), { owner: {} })
    }
    assert.throws(() => registry.register(target, () => ({ owners: [] }), { owner: {} }), /at most 16 providers/)
})

test('adapter inspection purpose defaults local, supports rum, freezes options, and isolates adapter contexts', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const target = {
        tagName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
        addEventListener() {},
        removeEventListener() {},
    }
    const mutatingContexts = []
    const observedContexts = []
    const initialPurposes = []
    const mutatingAdapter = {
        id: 'purpose-mutator',
        version: '1',
        canInspect: element => element === target,
        inspect: (_element, context) => {
            mutatingContexts.push(context)
            initialPurposes.push(context.inspectionPurpose)
            context.inspectionPurpose = context.inspectionPurpose === 'local' ? 'rum' : 'local'
            context.evidenceWindow.relation = 'interaction-window'
            return null
        },
    }
    const observingAdapter = {
        id: 'purpose-observer',
        version: '1',
        canInspect: element => element === target,
        inspect: (_element, context) => {
            observedContexts.push(context)
            return null
        },
    }
    const adapters = [mutatingAdapter, observingAdapter]

    const localOptions = { adapters }
    const localSelection = collector.selectElement(target, localOptions)
    localOptions.inspectionPurpose = 'rum'
    localSelection.snapshot()

    const rumOptions = { adapters, inspectionPurpose: 'rum' }
    const rumSelection = collector.selectElement(target, rumOptions)
    rumOptions.inspectionPurpose = 'local'
    rumSelection.snapshot()

    assert.deepEqual(initialPurposes, ['local', 'rum'])
    assert.deepEqual(
        observedContexts.map(context => [context.inspectionPurpose, context.evidenceWindow.relation]),
        [
            ['local', 'selection-window'],
            ['rum', 'selection-window'],
        ]
    )
    for (let index = 0; index < observedContexts.length; index += 1) {
        assert.notEqual(mutatingContexts[index], observedContexts[index])
        assert.notEqual(mutatingContexts[index].evidenceWindow, observedContexts[index].evidenceWindow)
    }

    localSelection.clear()
    rumSelection.clear()
    collector.destroy()
})

test('renderer adapters normalize bounded evidence and keep GPU timing fail-closed', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const target = {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 600,
        height: 300,
        ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 }),
        addEventListener() {},
        removeEventListener() {},
    }
    let renderer = {
        family: 'webgl',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: { cpuFrameMsP95: 2.5, gpuFrameMsP95: 4.25, drawCallsP95: 18 },
        evidence: {
            window: { startedAt: 100, endedAt: 160 },
            acceptedSampleCount: 8,
            retainedSampleCount: 6,
            droppedSampleCount: 2,
            rejectedSampleCount: 1,
            truncated: false,
            gpu: { valid: true, disjoint: false, contextLost: false, source: 'webgl-timer-query' },
        },
    }
    const adapter = {
        id: 'renderer-contract',
        version: '1.0.0',
        canInspect: element => element === target,
        inspect: () => ({ renderer }),
    }
    const selection = collector.selectElement(target, { adapters: [adapter] })
    runtime.advance(200)

    let snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.cpuFrameMsP95, 2.5)
    assert.equal(snapshot.metrics.gpuFrameMsP95, 4.25)
    assert.deepEqual(snapshot.evidence.window, { startedAt: 100, endedAt: 160, durationMs: 60 })
    assert.equal(snapshot.evidence.acceptedSampleCount, 8)
    assert.equal(snapshot.evidence.retainedSampleCount, 6)
    assert.equal(snapshot.evidence.droppedSampleCount, 2)
    assert.equal(snapshot.evidence.rejectedSampleCount, 1)
    assert.equal(snapshot.evidence.truncated, true)
    assert.deepEqual(snapshot.evidence.gpu, {
        valid: true,
        disjoint: false,
        contextLost: false,
        source: 'webgl-timer-query',
        rejectionReason: null,
    })

    renderer = {
        ...renderer,
        evidence: undefined,
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, null)
    assert.equal(snapshot.metrics.cpuFrameMsP95, null)
    assert.equal(snapshot.metrics.drawCallsP95, null)
    assert.deepEqual(snapshot.evidence.window, { startedAt: null, endedAt: null, durationMs: null })
    assert.equal(snapshot.evidence.acceptedSampleCount, null)
    assert.equal(snapshot.evidence.retainedSampleCount, null)
    assert.equal(snapshot.evidence.droppedSampleCount, null)
    assert.equal(snapshot.evidence.rejectedSampleCount, null)
    assert.equal(snapshot.evidence.truncated, null)
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'not-reported')
    assert.deepEqual(selection.snapshot().adapterErrors, ['renderer-contract:renderer-evidence-window-invalid'])

    renderer = {
        ...renderer,
        evidence: {
            window: { startedAt: 200, endedAt: 100 },
            acceptedSampleCount: 4,
            retainedSampleCount: 5,
            droppedSampleCount: 0,
            rejectedSampleCount: -1,
            truncated: 'yes',
            gpu: { valid: true, disjoint: true, contextLost: false, source: 'webgl-timer-query' },
        },
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, null)
    assert.deepEqual(snapshot.evidence.window, { startedAt: null, endedAt: null, durationMs: null })
    assert.equal(snapshot.evidence.acceptedSampleCount, null)
    assert.equal(snapshot.evidence.retainedSampleCount, null)
    assert.equal(snapshot.evidence.droppedSampleCount, null)
    assert.equal(snapshot.evidence.rejectedSampleCount, null)
    assert.equal(snapshot.evidence.truncated, null)
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'not-reported')

    renderer = {
        ...renderer,
        evidence: {
            window: { startedAt: 100, endedAt: 160 },
            gpu: { valid: true, disjoint: false, contextLost: true, source: 'host-summary' },
        },
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, null)
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'context-lost')

    renderer = {
        ...renderer,
        evidence: {
            window: { startedAt: 100, endedAt: 160 },
            gpu: { valid: true, disjoint: false, contextLost: false, source: 'untrusted-clock' },
        },
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, null)
    assert.equal(snapshot.evidence.gpu.source, 'unknown')
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'source-unknown')

    renderer = {
        family: 'webgpu',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: { gpuFrameMsP95: 5 },
        evidence: {
            window: { startedAt: 100, endedAt: 160 },
            acceptedSampleCount: 1,
            retainedSampleCount: 1,
            droppedSampleCount: 0,
            gpu: { valid: true, disjoint: false, contextLost: false, source: 'webgl-timer-query' },
        },
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, null)
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'backend-source-mismatch')

    renderer = {
        ...renderer,
        family: 'other',
        metrics: { gpuFrameMsP95: 5 },
        evidence: {
            window: { startedAt: 100, endedAt: 160 },
            acceptedSampleCount: 1,
            retainedSampleCount: 1,
            droppedSampleCount: 0,
            gpu: { valid: true, disjoint: false, contextLost: false, source: 'host-summary' },
        },
    }
    snapshot = selection.snapshot().renderers[0]
    assert.equal(snapshot.metrics.gpuFrameMsP95, 5)
    assert.equal(snapshot.evidence.gpu.rejectionReason, null)

    renderer = {
        family: 'webgl',
        capability: { state: 'unsupported', observed: false, buffered: false, reason: 'timer unavailable' },
        metrics: { cpuFrameMsP95: 2, gpuFrameMsP95: 3, drawCallsP95: 10 },
        evidence: {
            acceptedSampleCount: 4,
            retainedSampleCount: 4,
            droppedSampleCount: 0,
            gpu: { valid: true, disjoint: false, contextLost: false, source: 'host-summary' },
        },
    }
    const contradictory = selection.snapshot()
    snapshot = contradictory.renderers[0]
    assert.ok(Object.values(snapshot.metrics).every(value => value === null))
    assert.equal(snapshot.evidence.acceptedSampleCount, null)
    assert.equal(snapshot.evidence.gpu.rejectionReason, 'not-reported')
    assert.deepEqual(contradictory.adapterErrors, ['renderer-contract:renderer-capability-conflict'])

    selection.clear()
    collector.destroy()
})

test('renderer adapter post-processing isolates throwing nested getters without discarding normalized attribution', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const target = {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 300,
        height: 150,
        ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 }),
        addEventListener() {},
        removeEventListener() {},
    }
    const throwingMetrics = {}
    Object.defineProperty(throwingMetrics, 'drawCallsP95', {
        enumerable: true,
        get() {
            throw new Error('caller-owned metrics getter failed')
        },
    })
    const throwingWindow = { endedAt: 0 }
    Object.defineProperty(throwingWindow, 'startedAt', {
        enumerable: true,
        get() {
            throw new Error('caller-owned evidence getter failed')
        },
    })
    const adapters = [
        {
            id: 'throwing-metrics',
            version: '1.0.0',
            canInspect: element => element === target,
            inspect: () => ({
                inventory: { uiFrameworks: ['react'], renderers: ['canvas2d'] },
                owners: [{ relation: 'framework-owner', framework: 'react', label: 'Retained React owner' }],
                renderer: {
                    family: 'canvas2d',
                    capability: { state: 'supported', observed: true, buffered: false },
                    metrics: throwingMetrics,
                    evidence: {
                        window: { startedAt: 0, endedAt: 0 },
                        acceptedSampleCount: 1,
                        retainedSampleCount: 1,
                        droppedSampleCount: 0,
                    },
                },
            }),
        },
        {
            id: 'throwing-evidence',
            version: '1.0.0',
            canInspect: element => element === target,
            inspect: () => ({
                inventory: { uiFrameworks: ['vue'], renderers: ['webgl'] },
                owners: [{ relation: 'framework-owner', framework: 'vue', label: 'Retained Vue owner' }],
                renderer: {
                    family: 'webgl',
                    capability: { state: 'supported', observed: true, buffered: false },
                    metrics: { drawCallsP95: 2 },
                    evidence: {
                        window: throwingWindow,
                        acceptedSampleCount: 1,
                        retainedSampleCount: 1,
                        droppedSampleCount: 0,
                    },
                },
            }),
        },
        {
            id: 'valid-after-failures',
            version: '1.0.0',
            canInspect: element => element === target,
            inspect: () => ({
                owners: [{ relation: 'framework-owner', framework: 'solid', label: 'Owner-only Solid target' }],
                renderer: {
                    family: 'other',
                    capability: { state: 'supported', observed: true, buffered: false },
                    metrics: { drawCallsP95: 3 },
                    evidence: {
                        window: { startedAt: 0, endedAt: 0 },
                        acceptedSampleCount: 1,
                        retainedSampleCount: 1,
                        droppedSampleCount: 0,
                    },
                },
            }),
        },
    ]

    const selection = collector.selectElement(target, { adapters })
    const snapshot = selection.snapshot()

    assert.deepEqual(snapshot.adapterErrors, ['throwing-metrics:inspection-failed', 'throwing-evidence:inspection-failed'])
    assert.deepEqual(
        snapshot.renderers.map(renderer => renderer.adapterId),
        ['valid-after-failures']
    )
    assert.equal(snapshot.renderers[0].metrics.drawCallsP95, 3)
    assert.deepEqual(snapshot.inventory.uiFrameworks, ['react', 'vue', 'solid'])
    assert.deepEqual(snapshot.inventory.renderers, ['canvas', 'canvas2d', 'webgl', 'other'])
    assert.deepEqual(
        snapshot.owners.map(owner => [owner.adapterId, owner.framework, owner.label]),
        [
            ['throwing-metrics', 'react', 'Retained React owner'],
            ['throwing-evidence', 'vue', 'Retained Vue owner'],
            ['valid-after-failures', 'solid', 'Owner-only Solid target'],
        ]
    )

    selection.clear()
    collector.destroy()
})

test('renderer adapter windows use the collector monotonic clock and must fit the exact interaction window', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const target = {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 300,
        height: 150,
        ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 }),
        addEventListener() {},
        removeEventListener() {},
    }
    let rendererWindow = { startedAt: 100, endedAt: 100 }
    let advanceDuringInspect = false
    let inspectionContext = null
    const adapter = {
        id: 'clock-window',
        version: '1.0.0',
        canInspect: element => element === target,
        inspect: (_element, context) => {
            inspectionContext = context
            if (advanceDuringInspect) {
                runtime.advance(5)
                rendererWindow = { startedAt: 100, endedAt: runtime.now() }
            }
            return {
                renderer: {
                    family: 'webgl',
                    capability: { state: 'supported', observed: true, buffered: false },
                    metrics: { drawCallsP95: 4 },
                    evidence: {
                        window: rendererWindow,
                        acceptedSampleCount: 2,
                        retainedSampleCount: 2,
                        droppedSampleCount: 0,
                        rejectedSampleCount: 0,
                        truncated: false,
                    },
                },
            }
        },
    }

    const contextMutator = {
        id: 'context-mutator',
        version: '1.0.0',
        canInspect: element => element === target,
        inspect: (_element, context) => {
            context.evidenceWindow.endedAt = -1
            return null
        },
    }

    runtime.advance(100)
    const selection = collector.selectElement(target, { adapters: [contextMutator, adapter] })
    advanceDuringInspect = true
    let selected = selection.snapshot()
    advanceDuringInspect = false
    assert.equal(selected.capturedAt, 105)
    assert.equal(selected.renderers[0].metrics.drawCallsP95, 4)
    assert.deepEqual(selected.renderers[0].evidence.window, { startedAt: 100, endedAt: 105, durationMs: 5 })
    assert.deepEqual(inspectionContext, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 100, endedAt: 100, relation: 'selection-window' },
    })

    for (const invalidWindow of [
        { startedAt: 0, endedAt: 50 },
        { startedAt: 100, endedAt: runtime.now() + 1 },
        { startedAt: 1_750_000_000_000, endedAt: 1_750_000_000_001 },
        { startedAt: 100 },
        { startedAt: 100, endedAt: Number.NaN },
        { startedAt: 104, endedAt: 103 },
    ]) {
        rendererWindow = invalidWindow
        selected = selection.snapshot()
        assert.equal(selected.renderers[0].metrics.drawCallsP95, null)
        assert.deepEqual(selected.adapterErrors, ['clock-window:renderer-evidence-window-invalid'])
    }

    runtime.advance(95)
    const interaction = selection.beginInteraction('custom', 'renderer window')
    runtime.advance(20)
    interaction.end()
    rendererWindow = { startedAt: 190, endedAt: 210 }
    selected = selection.snapshot()
    assert.deepEqual(selected.correlatedWindow, { startedAt: 200, endedAt: 220, durationMs: 20 })
    assert.equal(selected.renderers[0].metrics.drawCallsP95, null)
    assert.deepEqual(selected.adapterErrors, ['clock-window:renderer-evidence-window-invalid'])

    rendererWindow = { startedAt: 201, endedAt: 219 }
    selected = selection.snapshot()
    assert.equal(selected.renderers[0].metrics.drawCallsP95, 4)
    assert.deepEqual(selected.adapterErrors, [])
    assert.deepEqual(inspectionContext, {
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 200, endedAt: 220, relation: 'interaction-window' },
    })

    selection.clear()
    runtime.time = 1_750_000_000_000
    rendererWindow = { startedAt: runtime.now(), endedAt: runtime.now() }
    const epochClockSelection = collector.selectElement(target, { adapters: [adapter] })
    selected = epochClockSelection.snapshot()
    assert.equal(selected.renderers[0].metrics.drawCallsP95, 4)
    assert.deepEqual(selected.renderers[0].evidence.window, {
        startedAt: 1_750_000_000_000,
        endedAt: 1_750_000_000_000,
        durationMs: 0,
    })
    epochClockSelection.clear()
    collector.destroy()
})

test('Canvas geometry separates CSS and backing resizes without counting ResizeObserver baseline delivery', () => {
    const observers = []
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback
            this.disconnected = false
            observers.push(this)
        }

        observe(element) {
            this.element = element
        }

        disconnect() {
            this.disconnected = true
        }

        emit() {
            this.callback([], this)
        }
    }

    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    const cssBox = { width: 400, height: 200 }
    const target = {
        tagName: 'CANVAS',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        isConnected: true,
        width: 800,
        height: 400,
        ownerDocument: {
            defaultView: { innerWidth: 1_000, innerHeight: 800, ResizeObserver: FakeResizeObserver },
        },
        getAttribute: () => null,
        getAnimations: () => [],
        getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: cssBox.width,
            bottom: cssBox.height,
            width: cssBox.width,
            height: cssBox.height,
        }),
        addEventListener() {},
        removeEventListener() {},
    }
    const selection = collector.selectElement(target)
    assert.equal(observers.length, 1)

    observers[0].emit()
    const unownedSnapshot = selection.snapshot()
    assert.deepEqual(unownedSnapshot.inventory.uiFrameworks, [])
    let geometry = unownedSnapshot.geometry
    assert.equal(geometry.resizeCount, 0)
    assert.equal(geometry.cssResizeCount, 0)
    assert.equal(geometry.backingResizeCount, 0)
    assert.equal(geometry.backingScaleX, 2)
    assert.equal(geometry.backingScaleY, 2)
    assert.equal(geometry.backingAspectRatioMismatch, false)
    assert.equal(geometry.effectivePixelRatio, 2)

    cssBox.width = 500
    observers[0].emit()
    geometry = selection.snapshot().geometry
    assert.equal(geometry.resizeCount, 1)
    assert.equal(geometry.cssResizeCount, 1)
    assert.equal(geometry.backingResizeCount, 0)
    assert.equal(geometry.backingScaleX, 1.6)
    assert.equal(geometry.backingScaleY, 2)
    assert.equal(geometry.backingAspectRatioMismatch, true)
    assert.equal(geometry.effectivePixelRatio, 1.789)

    target.width = 1_000
    target.height = 500
    geometry = selection.snapshot().geometry
    assert.equal(geometry.resizeCount, 2)
    assert.equal(geometry.cssResizeCount, 1)
    assert.equal(geometry.backingResizeCount, 1)
    assert.equal(geometry.backingScaleX, 2)
    assert.equal(geometry.backingScaleY, 2.5)
    assert.equal(geometry.backingAspectRatioMismatch, true)
    assert.equal(geometry.effectivePixelRatio, 2.236)

    selection.clear()
    assert.equal(observers[0].disconnected, true)
    collector.destroy()
})

class FakeNode {
    constructor(tag = '') {
        this.tag = tag
        this.tagName = tag.startsWith('#') ? '' : tag.toUpperCase()
        this.children = []
        this.attributes = new Map()
        this.textContent = ''
        this.className = ''
        this.parent = null
        this.listeners = new Map()
        this.focused = false
        this.style = {}
        this.isConnected = true
        this.scrollTop = 0
        this.scrollLeft = 0
        this.capturedPointers = new Set()
    }

    append(...children) {
        for (const child of children) this.appendChild(child)
    }

    appendChild(child) {
        child.parent = this
        this.children.push(child)
        return child
    }

    replaceChildren(...children) {
        this.children = []
        // Emptying a real scroll container clamps its offsets before the new
        // children are appended. Keep that browser behavior in the fake DOM.
        this.scrollTop = 0
        this.scrollLeft = 0
        this.append(...children)
    }

    setAttribute(name, value) {
        this.attributes.set(name, value)
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
    }

    dispatchEvent(event) {
        if (event.target == null) event.target = this
        event.currentTarget = this
        for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
        return true
    }

    click() {
        this.dispatchEvent({ type: 'click', detail: 0 })
    }

    focus() {
        this.focused = true
        let current = this.parent
        while (current) {
            if (current.tag === '#shadow-root') {
                current.activeElement = this
                break
            }
            current = current.parent
        }
    }

    contains(node) {
        if (node === this) return true
        return this.children.some(child => child.contains(node))
    }

    closest(selector) {
        return [...this.attributes.keys()].some(name => selector.includes(name)) ? this : null
    }

    getBoundingClientRect() {
        const left = Number.parseFloat(this.style.left) || 0
        const top = Number.parseFloat(this.style.top) || 0
        const width = this.rectWidth ?? 100
        const height = this.rectHeight ?? 50
        return { left, top, right: left + width, bottom: top + height, width, height }
    }

    setPointerCapture(pointerId) {
        this.capturedPointers.add(pointerId)
    }

    releasePointerCapture(pointerId) {
        this.capturedPointers.delete(pointerId)
    }

    hasPointerCapture(pointerId) {
        return this.capturedPointers.has(pointerId)
    }

    attachShadow() {
        this.shadowRoot = new FakeNode('#shadow-root')
        return this.shadowRoot
    }

    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
    }
}

class FakeDocument {
    constructor(storage = new Map()) {
        this.body = new FakeNode('body')
        this.documentElement = new FakeNode('html')
        this.body.ownerDocument = this
        this.documentElement.ownerDocument = this
        this.listeners = new Map()
        this.intervalMs = null
        this.cleared = false
        this.intervalCallback = null
        this.intervals = new Map()
        this.nextIntervalId = 7
        this.storage = storage
        this.windowListeners = new Map()
        this.defaultView = {
            setInterval: (callback, ms) => {
                this.intervalMs = ms
                this.intervalCallback = callback
                const id = this.nextIntervalId++
                this.intervals.set(id, { callback, ms })
                return id
            },
            clearInterval: id => {
                if (this.intervals.delete(id)) this.cleared = true
                const latest = [...this.intervals.values()].at(-1)
                this.intervalMs = latest?.ms ?? null
                this.intervalCallback = latest?.callback ?? null
            },
            innerWidth: 1_000,
            innerHeight: 800,
            localStorage: {
                getItem: key => this.storage.get(key) ?? null,
                setItem: (key, value) => this.storage.set(key, value),
            },
            addEventListener: (type, listener) => {
                const listeners = this.windowListeners.get(type) ?? new Set()
                listeners.add(listener)
                this.windowListeners.set(type, listeners)
            },
            removeEventListener: (type, listener) => this.windowListeners.get(type)?.delete(listener),
        }
    }

    hasInterval(ms) {
        return [...this.intervals.values()].some(interval => interval.ms === ms)
    }

    createElement(tag) {
        const node = new FakeNode(tag)
        node.ownerDocument = this
        return node
    }

    elementFromPoint() {
        return this.hit ?? null
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener)
    }

    removeEventListener(type, listener) {
        if (this.listeners.get(type) === listener) this.listeners.delete(type)
    }

    dispatchCaptured(type, values = {}) {
        let prevented = false
        let stopped = false
        this.listeners.get(type)?.({
            type,
            button: 0,
            clientX: 10,
            clientY: 10,
            composedPath: () => [this.hit],
            preventDefault: () => (prevented = true),
            stopPropagation: () => (stopped = true),
            stopImmediatePropagation() {},
            ...values,
        })
        return { prevented, stopped }
    }

    dispatchWindow(type) {
        for (const listener of [...(this.windowListeners.get(type) ?? [])]) listener({ type })
    }
}

function findFakeNodes(node, predicate) {
    const matches = predicate(node) ? [node] : []
    for (const child of node.children) matches.push(...findFakeNodes(child, predicate))
    return matches
}

function fakeNodeText(node) {
    return [node.textContent, ...node.children.map(fakeNodeText)].filter(Boolean).join(' ')
}

function dispatchFakePointer(node, type, values = {}) {
    const state = { prevented: false, stopped: false }
    node.dispatchEvent({
        type,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: 0,
        clientY: 0,
        detail: type === 'click' ? 1 : 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
        preventDefault() {
            state.prevented = true
        },
        stopPropagation() {
            state.stopped = true
        },
        stopImmediatePropagation() {
            state.stopped = true
        },
        ...values,
    })
    return state
}

test('one-shot element picker suppresses the inspected click, supports Escape, and cleans every listener', () => {
    class PickerNode {
        constructor(tag) {
            this.tagName = tag.toUpperCase()
            this.children = []
            this.attributes = new Map()
            this.style = {}
        }
        setAttribute(name, value) {
            this.attributes.set(name, value)
        }
        append(...nodes) {
            this.children.push(...nodes)
        }
        appendChild(node) {
            this.children.push(node)
            return node
        }
        attachShadow() {
            this.shadowRoot = new PickerNode('shadow')
            return this.shadowRoot
        }
        contains(node) {
            return node === this || this.children.some(child => child.contains?.(node))
        }
        closest(selector) {
            return selector.includes('data-condev-animation') && [...this.attributes.keys()].some(name => selector.includes(name))
                ? this
                : null
        }
        getBoundingClientRect() {
            return { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 }
        }
        remove() {
            this.removed = true
        }
    }
    class PickerDocument {
        constructor() {
            this.body = new PickerNode('body')
            this.documentElement = new PickerNode('html')
            this.listeners = new Map()
            this.windowListeners = new Map()
            this.defaultView = {
                addEventListener: (type, listener) => this.windowListeners.set(type, listener),
                removeEventListener: type => this.windowListeners.delete(type),
            }
        }
        createElement(tag) {
            return new PickerNode(tag)
        }
        elementFromPoint() {
            return this.hit
        }
        addEventListener(type, listener) {
            this.listeners.set(type, listener)
        }
        removeEventListener(type, listener) {
            if (this.listeners.get(type) === listener) this.listeners.delete(type)
        }
        dispatch(type, values = {}) {
            let prevented = false
            let stopped = false
            this.listeners.get(type)?.({
                type,
                button: 0,
                clientX: 20,
                clientY: 30,
                composedPath: () => [this.hit],
                preventDefault: () => (prevented = true),
                stopPropagation: () => (stopped = true),
                stopImmediatePropagation() {},
                ...values,
            })
            return { prevented, stopped }
        }
    }

    const document = new PickerDocument()
    const target = new PickerNode('canvas')
    document.hit = target
    let selected = null
    let cancelled = 0
    const picker = createAnimationElementPicker({
        document,
        onSelect: element => (selected = element),
        onCancel: () => (cancelled += 1),
    })
    assert.equal(picker.start(), true)
    assert.equal(picker.state, 'picking')
    const down = document.dispatch('pointerdown')
    const click = document.dispatch('click')
    assert.equal(down.prevented, true)
    assert.equal(click.stopped, true)
    assert.equal(selected, target)
    assert.equal(picker.state, 'selected')
    assert.equal(document.listeners.size, 0)

    assert.equal(picker.start(), true)
    const escape = document.dispatch('keydown', { key: 'Escape' })
    assert.equal(escape.prevented, true)
    assert.equal(picker.state, 'idle')
    assert.equal(cancelled, 1)
    picker.destroy()
    picker.destroy()
    assert.equal(picker.state, 'destroyed')
    assert.equal(document.listeners.size, 0)
})

test('dev overlay is a collapsed Shadow DOM dock, refreshes only while expanded, and no-ops in SSR/production', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 30])
    const document = new FakeDocument()
    let snapshots = 0
    const source = {
        get state() {
            return collector.state
        },
        snapshot() {
            snapshots += 1
            return collector.snapshot()
        },
    }
    const overlay = createAnimationDevOverlay(source, {
        document,
        production: false,
        refreshIntervalMs: 10,
    })
    assert.equal(overlay.mounted, true)
    assert.equal(overlay.refreshIntervalMs, 1_000)
    assert.equal(overlay.expanded, false)
    assert.equal(document.hasInterval(2_000), true)
    assert.equal(document.hasInterval(1_000), false)
    assert.equal(snapshots, 0)
    assert.equal(document.body.children.length, 1)
    const shadow = document.body.children[0].shadowRoot
    assert.ok(shadow)
    assert.match(shadow.children[0].textContent, /prefers-reduced-motion: reduce/)
    assert.match(shadow.children[0].textContent, /hover: hover.*pointer: fine/s)
    assert.doesNotMatch(shadow.children[0].textContent, /transition:\s*all/)
    const dock = shadow.children[1]
    const trigger = dock.children[0]
    const panel = dock.children[1]
    const rendererSurfaceToggle = findFakeNodes(panel, node => node.getAttribute('data-renderer-surface-toggle') !== null)[0]
    assert.ok(rendererSurfaceToggle)
    assert.equal(rendererSurfaceToggle.getAttribute('data-enabled'), 'true')
    assert.equal(rendererSurfaceToggle.getAttribute('aria-pressed'), 'true')
    assert.equal(rendererSurfaceToggle.textContent, 'Hide page markers')
    assert.equal(dock.getAttribute('data-expanded'), 'false')
    assert.equal(panel.getAttribute('role'), 'region')
    assert.equal(panel.getAttribute('aria-hidden'), 'true')
    assert.equal(panel.getAttribute('tabindex'), '0')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(trigger.getAttribute('aria-label'), 'Open Condev animation monitor')

    overlay.refresh()
    assert.equal(snapshots, 0)
    trigger.click()
    assert.equal(overlay.expanded, true)
    assert.equal(dock.getAttribute('data-expanded'), 'true')
    assert.equal(panel.getAttribute('aria-hidden'), 'false')
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(trigger.getAttribute('aria-label'), 'Close Condev animation monitor')
    assert.equal(document.hasInterval(1_000), true)
    assert.equal(snapshots, 1)
    const stablePanelShell = [...panel.children]
    overlay.refresh()
    assert.equal(snapshots, 2)
    assert.deepEqual(panel.children, stablePanelShell)

    let escapePrevented = false
    let escapePropagationStopped = false
    shadow.dispatchEvent({
        type: 'keydown',
        key: 'Escape',
        preventDefault() {
            escapePrevented = true
        },
        stopPropagation() {
            escapePropagationStopped = true
        },
    })
    assert.equal(overlay.expanded, false)
    assert.equal(trigger.focused, true)
    assert.equal(escapePrevented, true)
    assert.equal(escapePropagationStopped, true)
    assert.equal(document.cleared, true)
    assert.equal(document.hasInterval(1_000), false)
    assert.equal(document.hasInterval(2_000), true)
    overlay.refresh()
    assert.equal(snapshots, 2)

    let enterPropagationStopped = false
    let keyUpPropagationStopped = false
    shadow.dispatchEvent({
        type: 'keydown',
        key: 'Enter',
        stopPropagation() {
            enterPropagationStopped = true
        },
    })
    shadow.dispatchEvent({
        type: 'keyup',
        key: 'Enter',
        stopPropagation() {
            keyUpPropagationStopped = true
        },
    })
    assert.equal(enterPropagationStopped, true)
    assert.equal(keyUpPropagationStopped, true)

    overlay.setExpanded(true)
    assert.equal(overlay.expanded, true)
    assert.equal(snapshots, 3)
    trigger.focused = false
    panel.focus()
    overlay.toggle()
    assert.equal(overlay.expanded, false)
    assert.equal(trigger.focused, true)
    overlay.destroy()
    overlay.destroy()
    assert.equal(document.body.children.length, 0)

    const containedInputStopped = new Set()
    const containmentDocument = new FakeDocument()
    const containmentOverlay = createAnimationDevOverlay(source, { document: containmentDocument, production: false })
    const containmentShadow = containmentDocument.body.children[0].shadowRoot
    for (const type of ['pointerdown', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove']) {
        containmentShadow.dispatchEvent({
            type,
            stopPropagation() {
                containedInputStopped.add(type)
            },
        })
    }
    assert.deepEqual(
        [...containedInputStopped],
        ['pointerdown', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove']
    )
    containmentOverlay.destroy()

    for (const [requested, expected] of [
        [Number.NaN, 1_000],
        [Number.POSITIVE_INFINITY, 1_000],
        [Number.NEGATIVE_INFINITY, 1_000],
        [3_000_000_000, 2_147_483_647],
    ]) {
        const intervalDocument = new FakeDocument()
        const intervalOverlay = createAnimationDevOverlay(source, {
            document: intervalDocument,
            production: false,
            initiallyOpen: true,
            refreshIntervalMs: requested,
        })
        assert.equal(intervalOverlay.refreshIntervalMs, expected)
        assert.equal(intervalDocument.hasInterval(expected), true)
        intervalOverlay.destroy()
    }

    const production = createAnimationDevOverlay(collector, { document, production: true })
    assert.equal(production.mounted, false)
    assert.equal(production.expanded, false)
    production.setExpanded(true)
    production.toggle()
    const ssr = createAnimationDevOverlay(collector, { production: false })
    assert.equal(ssr.mounted, false)
    collector.destroy()
})

test('local evidence accepts legacy schema-v1 closed snapshots without browser video evidence', () => {
    const legacy = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providerCount: 0,
        rejectedProviderCount: 0,
        droppedProviderCount: 0,
        truncated: false,
        media: { providerCount: 0, retainedRecordCount: 0, droppedRecordCount: 0, records: [], truncated: false },
        motion: { providerCount: 0, retainedRecordCount: 0, droppedRecordCount: 0, records: [], truncated: false },
    })

    assert.ok(legacy)
    assert.deepEqual(legacy.browserVideoPresentation, {
        providerCount: 0,
        retainedRecordCount: 0,
        droppedRecordCount: 0,
        records: [],
        truncated: false,
    })
})

test('dev overlay renders bounded local semantic evidence separately, preserves its scroll, and never polls it while collapsed', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 17, 18])
    const checkpoint = boundary => ({
        boundary,
        status: 'measured',
        configuredSourceCount: 1,
        measuredSourceCount: 1,
        unobservedSourceCount: 0,
        errorSourceCount: 0,
        sourceStatus: {
            'gsap-ticker': 'measured',
            'lenis-scroll': 'not-configured',
            'scroll-trigger': 'not-configured',
        },
    })
    const localEvidence = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providers: [
            {
                kind: 'media',
                snapshot: {
                    droppedAttemptCount: 0,
                    attempts: [
                        {
                            attemptId: 17,
                            label: 'private media label',
                            url: 'https://private.example/video.mp4',
                            kind: 'video',
                            outcome: 'completed',
                            durationMs: 30,
                            decodeReady: {
                                stage: 'decode-ready',
                                elapsedMs: 10,
                                durationMs: 4,
                                byteCount: 256,
                                itemCount: 1,
                            },
                            uploadReady: {
                                stage: 'upload-ready',
                                elapsedMs: 20,
                                durationMs: 3,
                                byteCount: 256,
                                itemCount: 1,
                            },
                            firstVisible: {
                                stage: 'first-visible',
                                elapsedMs: 25,
                                durationMs: null,
                                byteCount: null,
                                itemCount: null,
                            },
                        },
                    ],
                },
            },
            {
                kind: 'motion',
                snapshot: {
                    droppedInteractionCount: 0,
                    interactions: [
                        {
                            id: 'private-motion-id',
                            label: 'private motion label',
                            kind: 'scroll',
                            outcome: 'completed',
                            durationMs: 40,
                            before: checkpoint('before-interaction'),
                            after: checkpoint('after-interaction'),
                        },
                    ],
                },
            },
            {
                kind: 'browser-video-presentation',
                snapshot: {
                    droppedRecordCount: 0,
                    records: [
                        {
                            callbackAt: 240,
                            callbackIntervalMs: 16.7,
                            mediaTimeDeltaMs: 16.7,
                            presentedFramesDelta: 1,
                            expectedDisplayDeltaMs: 3,
                            processingDurationMs: 2,
                            src: 'https://private.example/video.mp4',
                            gpuUploadMs: 9,
                        },
                    ],
                },
            },
        ],
    })
    assert.ok(localEvidence)

    const document = new FakeDocument()
    let localEvidenceReads = 0
    const source = {
        state: 'running',
        snapshot: () => collector.snapshot(),
        localEvidenceSnapshot() {
            localEvidenceReads += 1
            return localEvidence
        },
    }
    const overlay = createAnimationDevOverlay(source, { document, production: false })
    const panel = document.body.children[0].shadowRoot.children[1].children[1]
    const evidencePanel = findFakeNodes(panel, node => node.getAttribute('data-overlay-local-evidence') !== null)[0]
    assert.ok(evidencePanel)
    assert.equal(evidencePanel.hidden, true)
    assert.equal(localEvidenceReads, 0)

    overlay.setExpanded(true)
    assert.equal(localEvidenceReads, 1)
    assert.equal(evidencePanel.hidden, false)
    assert.match(fakeNodeText(evidencePanel), /Local semantic evidence/)
    assert.match(fakeNodeText(evidencePanel), /caller-attested/)
    assert.match(fakeNodeText(evidencePanel), /explicit temporal correlations/)
    assert.match(fakeNodeText(evidencePanel), /decode ready \+10 ms/)
    assert.match(fakeNodeText(evidencePanel), /Browser video presentation callbacks/)
    assert.match(fakeNodeText(evidencePanel), /decode processing 2 ms/)
    assert.match(fakeNodeText(evidencePanel), /does not prove GPU upload completion/)
    assert.match(fakeNodeText(evidencePanel), /before measured 1\/1 → after measured 1\/1/)
    assert.doesNotMatch(fakeNodeText(evidencePanel), /private|example|motion-id/)

    evidencePanel.scrollTop = 91
    evidencePanel.scrollLeft = 7
    overlay.refresh()
    assert.equal(localEvidenceReads, 2)
    assert.equal(evidencePanel.scrollTop, 91)
    assert.equal(evidencePanel.scrollLeft, 7)

    const localeButton = findFakeNodes(panel, node => node.getAttribute('data-overlay-locale-toggle') !== null)[0]
    localeButton.click()
    assert.match(fakeNodeText(evidencePanel), /本地语义证据/)
    assert.match(fakeNodeText(evidencePanel), /媒体阶段由调用方声明/)
    assert.match(fakeNodeText(evidencePanel), /浏览器视频呈现回调/)
    assert.match(fakeNodeText(evidencePanel), /解码处理 2 ms/)
    assert.match(fakeNodeText(evidencePanel), /之前 measured 1\/1 → 之后 measured 1\/1/)
    assert.equal(evidencePanel.scrollTop, 91)

    overlay.setExpanded(false)
    overlay.refresh()
    assert.equal(localEvidenceReads, 2)
    overlay.destroy()

    const hostileDocument = new FakeDocument()
    const hostileSource = {
        state: 'running',
        snapshot: () => collector.snapshot(),
        get localEvidenceSnapshot() {
            throw new Error('hostile local evidence getter')
        },
    }
    const hostileOverlay = createAnimationDevOverlay(hostileSource, {
        document: hostileDocument,
        production: false,
        initiallyOpen: true,
    })
    const hostilePanel = hostileDocument.body.children[0].shadowRoot.children[1].children[1]
    const hiddenEvidence = findFakeNodes(hostilePanel, node => node.getAttribute('data-overlay-local-evidence') !== null)[0]
    assert.equal(hiddenEvidence.hidden, false)
    assert.match(fakeNodeText(hiddenEvidence), /Local semantic evidence/)
    assert.match(fakeNodeText(hiddenEvidence), /provider returned invalid data/)
    assert.doesNotMatch(fakeNodeText(hiddenEvidence), /hostile local evidence getter/)
    assert.match(fakeNodeText(hostilePanel), /Live rAF cadence/)
    hostileOverlay.destroy()

    const emptyDocument = new FakeDocument()
    const emptyOverlay = createAnimationDevOverlay(
        {
            state: 'running',
            snapshot: () => collector.snapshot(),
            localEvidenceSnapshot: () => projectAnimationLocalEvidenceSnapshot({ version: 1, providers: [] }),
        },
        { document: emptyDocument, production: false, initiallyOpen: true }
    )
    const emptyPanel = emptyDocument.body.children[0].shadowRoot.children[1].children[1]
    const emptyEvidence = findFakeNodes(emptyPanel, node => node.getAttribute('data-overlay-local-evidence') !== null)[0]
    assert.equal(emptyEvidence.hidden, true)
    emptyOverlay.destroy()
    collector.destroy()
})

test('dev overlay renders projected automatic page evidence, preserves scroll, and never polls it while collapsed', () => {
    const pageEvidenceFixture = (enabled = true) => ({
        schemaVersion: 1,
        scope: 'capture-window-local',
        enabled,
        elapsedMs: 2_000,
        sampleCount: enabled ? 4 : 0,
        privateUrl: 'https://private.example/animation',
        documentScopes: {
            capability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false, reason: 'private reason' },
            retainedCount: enabled ? 2 : 0,
            capacity: 64,
            truncated: false,
        },
        animations: {
            capability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            status: enabled ? 'partial' : 'not-observed',
            sampleCount: enabled ? 4 : 0,
            current: {
                total: enabled ? 8 : 0,
                inspected: enabled ? 7 : 0,
                dropped: enabled ? 1 : 0,
                running: enabled ? 3 : 0,
                paused: 0,
                finished: enabled ? 4 : 0,
                idle: 0,
                unknownState: 0,
                pending: 0,
                cssAnimations: enabled ? 2 : 0,
                cssTransitions: enabled ? 3 : 0,
                webAnimationsOrUnclassified: enabled ? 2 : 0,
                infinite: enabled ? 1 : 0,
            },
            peakTotal: enabled ? 9 : 0,
            peakRunning: enabled ? 4 : 0,
            lifecycle: {
                animationStartCount: enabled ? 5 : 0,
                animationEndCount: enabled ? 4 : 0,
                animationCancelCount: enabled ? 1 : 0,
                transitionRunCount: enabled ? 6 : 0,
                transitionEndCount: enabled ? 5 : 0,
                transitionCancelCount: enabled ? 1 : 0,
            },
            entries: [{ id: 'private-animation-id', name: 'private animation name' }],
        },
        media: {
            capability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            status: enabled ? 'partial' : 'not-observed',
            currentVideoCount: enabled ? 3 : 0,
            retainedVideoCount: enabled ? 2 : 0,
            droppedVideoCount: enabled ? 1 : 0,
            distinctRetainedVideoCount: enabled ? 2 : 0,
            activeProbeCount: enabled ? 2 : 0,
            rvfcSupportedVideoCount: enabled ? 1 : 0,
            rvfcUnsupportedVideoCount: enabled ? 1 : 0,
            playingVideoCount: enabled ? 2 : 0,
            mediaUrl: 'https://private.example/video.mp4',
        },
        rendererSurfaces: {
            discoveryCapability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            contextObservationCapability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            status: enabled ? 'measured' : 'not-observed',
            sampleCount: enabled ? 4 : 0,
            current: {
                total: enabled ? 6 : 0,
                retained: enabled ? 6 : 0,
                dropped: 0,
                svg: enabled ? 1 : 0,
                canvasUnknown: enabled ? 1 : 0,
                canvas2d: enabled ? 1 : 0,
                webgl: enabled ? 1 : 0,
                webgl2: enabled ? 1 : 0,
                webgpu: enabled ? 1 : 0,
            },
            peakTotal: enabled ? 6 : 0,
            distinctRetainedSurfaceCount: enabled ? 6 : 0,
            addedAfterStartCount: enabled ? 1 : 0,
            removedCount: 0,
            successfulContextObservationCount: enabled ? 4 : 0,
            webglContextLostCount: enabled ? 1 : 0,
            webglContextRestoredCount: enabled ? 1 : 0,
            rendererWorkCapability: { state: 'unsupported', observed: false, buffered: false },
            gpuTimingCapability: { state: 'unsupported', observed: false, buffered: false, reason: 'private gpu reason' },
        },
        workAvoidance: {
            visibilityCapability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            intersectionCapability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            status: enabled ? 'measured' : 'not-observed',
            visibilityState: enabled ? 'hidden' : 'unknown',
            sampleCount: enabled ? 4 : 0,
            hiddenSampleCount: enabled ? 1 : 0,
            trackedIntersectionTargetCount: enabled ? 4 : 0,
            knownIntersectionTargetCount: enabled ? 4 : 0,
            hiddenRunningAnimationReviewSampleCount: enabled ? 2 : 0,
            hiddenPlayingVideoReviewSampleCount: enabled ? 1 : 0,
            offscreenRunningAnimationReviewSampleCount: enabled ? 3 : 0,
            offscreenPlayingVideoReviewSampleCount: enabled ? 1 : 0,
            current: {
                hiddenRunningAnimations: enabled ? 2 : 0,
                hiddenPlayingVideos: enabled ? 1 : 0,
                offscreenRunningAnimations: enabled ? 3 : 0,
                offscreenPlayingVideos: enabled ? 1 : 0,
            },
            workDurationCapability: { state: 'unsupported', observed: false, buffered: false },
        },
        reducedMotion: {
            capability: { state: enabled ? 'supported' : 'unknown', observed: enabled, buffered: false },
            status: enabled ? 'measured' : 'not-observed',
            preference: enabled ? true : null,
            preferenceChangeCount: 0,
            reducedMotionSampleCount: enabled ? 2 : 0,
            reviewCandidateSampleCount: enabled ? 2 : 0,
            current: {
                runningAnimationCandidates: enabled ? 2 : 0,
                infiniteAnimationCandidates: enabled ? 1 : 0,
                playingVideoCandidates: enabled ? 1 : 0,
            },
            violationCapability: { state: 'unsupported', observed: false, buffered: false },
        },
    })

    const projected = projectAnimationOverlayPageEvidenceSnapshot(pageEvidenceFixture())
    assert.ok(projected)
    assert.equal(projected.animations.current.total, 8)
    assert.equal(projected.rendererSurfaces.current.webgpu, 1)
    assert.doesNotMatch(JSON.stringify(projected), /private|example|animation-id/)

    for (const mutate of [
        evidence => {
            evidence.animations.current.running = 8
        },
        evidence => {
            evidence.animations.peakTotal = 7
        },
        evidence => {
            evidence.media.retainedVideoCount = 1
        },
        evidence => {
            evidence.rendererSurfaces.current.webgpu = 2
        },
        evidence => {
            evidence.animations.capability = { state: 'unsupported', observed: true, buffered: false }
        },
        evidence => {
            evidence.workAvoidance.hiddenRunningAnimationReviewSampleCount = 5
        },
        evidence => {
            evidence.reducedMotion.current.infiniteAnimationCandidates = 3
        },
        evidence => {
            evidence.reducedMotion.preference = false
            evidence.reducedMotion.status = 'not-applicable'
        },
        evidence => {
            evidence.rendererSurfaces.contextObservationCapability = { state: 'unsupported', observed: false, buffered: false }
        },
        evidence => {
            evidence.animations.status = 'measured'
            evidence.animations.sampleCount = 0
            evidence.animations.current.total = 7
            evidence.animations.current.dropped = 0
        },
        evidence => {
            evidence.rendererSurfaces.sampleCount = 0
        },
        evidence => {
            evidence.media.status = 'measured'
            evidence.media.currentVideoCount = 0
            evidence.media.retainedVideoCount = 0
            evidence.media.droppedVideoCount = 0
            evidence.media.activeProbeCount = 0
            evidence.media.rvfcSupportedVideoCount = 0
            evidence.media.rvfcUnsupportedVideoCount = 0
            evidence.media.playingVideoCount = 0
        },
        evidence => {
            evidence.workAvoidance.intersectionCapability = { state: 'unsupported', observed: false, buffered: false }
        },
        evidence => {
            evidence.workAvoidance.intersectionCapability = { state: 'supported', observed: false, buffered: false }
        },
    ]) {
        const contradictory = structuredClone(pageEvidenceFixture())
        mutate(contradictory)
        assert.equal(projectAnimationOverlayPageEvidenceSnapshot(contradictory), null)
    }

    const incompleteScopeWithoutMedia = structuredClone(pageEvidenceFixture())
    incompleteScopeWithoutMedia.documentScopes.truncated = true
    incompleteScopeWithoutMedia.media.status = 'partial'
    incompleteScopeWithoutMedia.media.currentVideoCount = 0
    incompleteScopeWithoutMedia.media.retainedVideoCount = 0
    incompleteScopeWithoutMedia.media.droppedVideoCount = 0
    incompleteScopeWithoutMedia.media.activeProbeCount = 0
    incompleteScopeWithoutMedia.media.rvfcSupportedVideoCount = 0
    incompleteScopeWithoutMedia.media.rvfcUnsupportedVideoCount = 0
    incompleteScopeWithoutMedia.media.playingVideoCount = 0
    incompleteScopeWithoutMedia.rendererSurfaces.status = 'partial'
    incompleteScopeWithoutMedia.workAvoidance.status = 'partial'
    incompleteScopeWithoutMedia.workAvoidance.current.hiddenPlayingVideos = 0
    incompleteScopeWithoutMedia.workAvoidance.current.offscreenPlayingVideos = 0
    incompleteScopeWithoutMedia.reducedMotion.current.playingVideoCandidates = 0
    assert.ok(projectAnimationOverlayPageEvidenceSnapshot(incompleteScopeWithoutMedia))

    const unknownVisibilityWithMeasuredWork = structuredClone(pageEvidenceFixture())
    unknownVisibilityWithMeasuredWork.workAvoidance.visibilityCapability = {
        state: 'unknown',
        observed: false,
        buffered: false,
    }
    unknownVisibilityWithMeasuredWork.workAvoidance.visibilityState = 'unknown'
    unknownVisibilityWithMeasuredWork.workAvoidance.current.hiddenRunningAnimations = 0
    unknownVisibilityWithMeasuredWork.workAvoidance.current.hiddenPlayingVideos = 0
    assert.ok(projectAnimationOverlayPageEvidenceSnapshot(unknownVisibilityWithMeasuredWork))

    const historicalOffscreenWithoutCurrentTargets = structuredClone(pageEvidenceFixture())
    historicalOffscreenWithoutCurrentTargets.workAvoidance.trackedIntersectionTargetCount = 0
    historicalOffscreenWithoutCurrentTargets.workAvoidance.knownIntersectionTargetCount = 0
    historicalOffscreenWithoutCurrentTargets.workAvoidance.current.offscreenRunningAnimations = 0
    historicalOffscreenWithoutCurrentTargets.workAvoidance.current.offscreenPlayingVideos = 0
    assert.ok(projectAnimationOverlayPageEvidenceSnapshot(historicalOffscreenWithoutCurrentTargets))

    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 17, 18])
    const document = new FakeDocument()
    let pageEvidenceReads = 0
    const source = {
        state: 'running',
        snapshot: () => collector.snapshot(),
        pageEvidenceSnapshot() {
            pageEvidenceReads += 1
            return pageEvidenceFixture()
        },
    }
    const overlay = createAnimationDevOverlay(source, { document, production: false })
    const panel = document.body.children[0].shadowRoot.children[1].children[1]
    const evidencePanel = findFakeNodes(panel, node => node.getAttribute('data-overlay-page-evidence') !== null)[0]
    assert.ok(evidencePanel)
    assert.equal(evidencePanel.hidden, false)
    assert.equal(evidencePanel.parent.hidden, true)
    assert.equal(pageEvidenceReads, 0)

    overlay.setExpanded(true)
    assert.equal(pageEvidenceReads, 1)
    assert.equal(evidencePanel.hidden, false)
    assert.equal(evidencePanel.parent.className, 'tab-panel page-evidence-tab')
    assert.equal(evidencePanel.parent.hidden, true)
    const pageEvidenceTab = findFakeNodes(panel, node => node.getAttribute('data-overlay-tab') === 'pageEvidence')[0]
    const overviewTabPanel = findFakeNodes(panel, node => node.className.includes('overview-panel'))[0]
    pageEvidenceTab.click()
    assert.equal(evidencePanel.parent.hidden, false)
    assert.equal(overviewTabPanel.hidden, true)
    assert.match(fakeNodeText(evidencePanel), /Automatic page evidence/)
    assert.match(fakeNodeText(evidencePanel), /CSS \/ Web Animations · partial/)
    assert.match(fakeNodeText(evidencePanel), /current 8 · running 3 · infinite 1/)
    assert.match(fakeNodeText(evidencePanel), /WebGPU 1/)
    assert.match(fakeNodeText(evidencePanel), /candidate signals hidden animation\/video 2\/1 · offscreen animation\/video 3\/1/)
    assert.match(fakeNodeText(evidencePanel), /preference reduce/)
    assert.doesNotMatch(fakeNodeText(evidencePanel), /private|example|animation-id/)

    evidencePanel.scrollTop = 83
    evidencePanel.scrollLeft = 5
    overlay.refresh()
    assert.equal(pageEvidenceReads, 2)
    assert.equal(evidencePanel.scrollTop, 83)
    assert.equal(evidencePanel.scrollLeft, 5)

    const localeButton = findFakeNodes(panel, node => node.getAttribute('data-overlay-locale-toggle') !== null)[0]
    localeButton.click()
    assert.match(fakeNodeText(evidencePanel), /自动页面证据/)
    assert.match(fakeNodeText(evidencePanel), /候选信号：后台动画\/视频 2\/1 · 离屏动画\/视频 3\/1/)
    assert.equal(evidencePanel.scrollTop, 83)

    overlay.setExpanded(false)
    overlay.refresh()
    assert.equal(pageEvidenceReads, 2)
    overlay.destroy()

    const hostileDocument = new FakeDocument()
    const hostileOverlay = createAnimationDevOverlay(
        {
            state: 'running',
            snapshot: () => collector.snapshot(),
            get pageEvidenceSnapshot() {
                throw new Error('private hostile provider error')
            },
        },
        { document: hostileDocument, production: false, initiallyOpen: true }
    )
    const hostilePanel = hostileDocument.body.children[0].shadowRoot.children[1].children[1]
    const unavailableEvidence = findFakeNodes(hostilePanel, node => node.getAttribute('data-overlay-page-evidence') !== null)[0]
    assert.equal(unavailableEvidence.hidden, false)
    assert.match(fakeNodeText(unavailableEvidence), /provider returned invalid data/)
    assert.doesNotMatch(fakeNodeText(unavailableEvidence), /private hostile/)
    hostileOverlay.destroy()

    const disabledDocument = new FakeDocument()
    const disabledOverlay = createAnimationDevOverlay(
        {
            state: 'running',
            snapshot: () => collector.snapshot(),
            pageEvidenceSnapshot: () => pageEvidenceFixture(false),
        },
        { document: disabledDocument, production: false, initiallyOpen: true }
    )
    const disabledPanel = disabledDocument.body.children[0].shadowRoot.children[1].children[1]
    const disabledEvidence = findFakeNodes(disabledPanel, node => node.getAttribute('data-overlay-page-evidence') !== null)[0]
    assert.equal(disabledEvidence.hidden, false)
    assert.match(fakeNodeText(disabledEvidence), /disabled for this client/)
    disabledOverlay.destroy()
    collector.destroy()
})

test('dev overlay launcher and expanded panel are independently draggable, keyboard movable, bounded, and persisted', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 16, 16])
    const storage = new Map()
    const document = new FakeDocument(storage)
    const overlay = createAnimationDevOverlay(collector, { document, production: false })
    const shadow = document.body.children[0].shadowRoot
    const dock = shadow.children[1]
    const trigger = dock.children[0]
    const panel = dock.children[1]
    const product = findFakeNodes(panel, node => node.getAttribute('data-overlay-panel-drag-handle') !== null)[0]

    assert.ok(product)
    assert.match(trigger.getAttribute('aria-describedby'), /move-help/u)
    assert.match(product.getAttribute('aria-keyshortcuts'), /Alt\+ArrowUp/u)

    const launcherDown = dispatchFakePointer(trigger, 'pointerdown', { clientX: 20, clientY: 20 })
    const launcherMove = dispatchFakePointer(trigger, 'pointermove', { clientX: 140, clientY: 100 })
    dispatchFakePointer(trigger, 'pointerup', { clientX: 140, clientY: 100, buttons: 0 })
    assert.equal(launcherDown.prevented, false)
    assert.equal(launcherMove.prevented, true)
    assert.equal(trigger.hasPointerCapture(1), false)
    assert.equal(dock.style.left, '120px')
    assert.equal(dock.style.top, '80px')

    dispatchFakePointer(trigger, 'click', { detail: 1 })
    assert.equal(overlay.expanded, false)
    trigger.click()
    assert.equal(overlay.expanded, true)

    const panelDown = dispatchFakePointer(product, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 2 })
    const panelMove = dispatchFakePointer(product, 'pointermove', { clientX: 260, clientY: 170, pointerId: 2 })
    dispatchFakePointer(product, 'pointerup', { clientX: 260, clientY: 170, pointerId: 2, buttons: 0 })
    assert.equal(panelDown.prevented, false)
    assert.equal(panelMove.prevented, true)
    assert.equal(panel.style.left, '250px')
    assert.equal(panel.style.top, '160px')
    assert.equal(overlay.expanded, true)

    let keyboardPrevented = false
    product.dispatchEvent({
        type: 'keydown',
        key: 'ArrowRight',
        altKey: true,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault() {
            keyboardPrevented = true
        },
        stopPropagation() {},
    })
    assert.equal(keyboardPrevented, true)
    assert.equal(panel.style.left, '260px')

    const stored = JSON.parse(storage.get('condev-animation-overlay-v2'))
    assert.equal(stored.positions.version, 1)
    assert.ok(stored.positions.launcher.xRatio > 0)
    assert.ok(stored.positions.panel.xRatio > 0)

    document.defaultView.innerWidth = 300
    document.defaultView.innerHeight = 220
    document.dispatchWindow('resize')
    assert.equal(Number.parseFloat(panel.style.left) <= 186, true)
    assert.equal(Number.parseFloat(panel.style.top) <= 156, true)

    let resetPrevented = false
    product.dispatchEvent({
        type: 'keydown',
        key: 'Home',
        altKey: true,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault() {
            resetPrevented = true
        },
        stopPropagation() {},
    })
    assert.equal(resetPrevented, true)
    assert.equal(panel.style.left, '')
    assert.equal(panel.style.top, '')
    assert.equal(JSON.parse(storage.get('condev-animation-overlay-v2')).positions.panel, undefined)

    overlay.destroy()
    assert.equal(document.windowListeners.get('resize')?.size ?? 0, 0)

    const restoredDocument = new FakeDocument(storage)
    const restoredOverlay = createAnimationDevOverlay(collector, { document: restoredDocument, production: false })
    const restoredDock = restoredDocument.body.children[0].shadowRoot.children[1]
    assert.notEqual(restoredDock.style.left, '')
    assert.notEqual(restoredDock.style.top, '')
    restoredOverlay.destroy()
    collector.destroy()
})

test('dev overlay ranks every measured finding and exposes workbench, interaction, and explicit coverage views', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 32, 48])
    const interaction = collector.beginInteraction('drag', 'gallery drag')
    runtime.tick(160)
    interaction.end()
    const snapshot = collector.snapshot()
    const statistics = (value, count = 100) => ({
        count,
        p50: value,
        p75: value,
        p95: value,
        p99: value,
        max: value,
        total: value * count,
    })
    snapshot.elapsedMs = 10_000
    snapshot.capturedAt = 10_000
    snapshot.frameBudget.confidence = 'high'
    snapshot.frameBudget.sampleCount = 100
    snapshot.frameBudget.expectedRefreshHz = 60
    snapshot.frames.duration = statistics(40)
    snapshot.frames.retainedCount = 100
    snapshot.frames.totalObservedCount = 100
    snapshot.longTasks.duration = statistics(120)
    snapshot.longAnimationFrames.styleAndLayoutTailDuration = statistics(40)
    snapshot.longAnimationFrames.paintTiming = {
        paintTimeCapability: { state: 'supported', observed: true, buffered: true },
        presentationTimeCapability: { state: 'supported', observed: true, buffered: true },
        paintTimeExposedCount: 4,
        presentationTimeExposedCount: 4,
        renderStartToPaintTotalObservedCount: 4,
        paintToPresentationTotalObservedCount: 3,
        renderStartToPaintDuration: statistics(12, 4),
        paintToPresentationDuration: statistics(3, 3),
    }
    snapshot.eventTiming.inputDelay = statistics(140)
    snapshot.eventTiming.processingDuration = statistics(150)
    snapshot.eventTiming.presentationDelay = statistics(160)
    snapshot.monitorOverhead.callbackCount = 100
    snapshot.monitorOverhead.totalCallbackDurationMs = 300
    Object.assign(snapshot.captureSufficiency, {
        status: 'insufficient',
        reasons: ['visible-window-too-short', 'insufficient-frame-samples'],
        visibleDurationMs: 1_250,
        hiddenDurationMs: 500,
        otherDurationMs: 0,
    })
    snapshot.webVitals.latest.LCP = {
        name: 'LCP',
        value: 1_250,
        delta: 1_250,
        rating: 'good',
        navigationType: 'navigate',
        attribution: {},
    }
    snapshot.webVitals.latest.INP = null
    snapshot.webVitals.latest.CLS = {
        name: 'CLS',
        value: 0.08,
        delta: 0.08,
        rating: 'needs-improvement',
        navigationType: 'navigate',
        attribution: {},
    }
    const resourceCategory = (count, duration, transferSize) => ({
        totalObservedCount: count,
        totalDurationMs: duration * count,
        transferSizeBytes: transferSize,
        encodedBodySizeBytes: transferSize,
        decodedBodySizeBytes: transferSize * 2,
        zeroTransferSizeCount: transferSize === 0 ? count : 0,
        duration: statistics(duration, count),
    })
    Object.assign(snapshot.resourceTiming, {
        retainedCount: 12,
        totalObservedCount: 17,
        droppedSampleCount: 5,
        rejectedEntryCount: 2,
        bufferFullEventCount: 1,
        excludedPreCaptureCount: 3,
        totalDurationMs: 714,
        transferSizeBytes: 8_192,
        encodedBodySizeBytes: 4_096,
        decodedBodySizeBytes: null,
        zeroTransferSizeCount: 2,
        duration: statistics(42, 17),
        categories: {
            script: resourceCategory(4, 18, 2_048),
            image: resourceCategory(6, 30, 4_096),
            media: resourceCategory(2, 120, 0),
            'fetch-xhr': resourceCategory(3, 24, 1_024),
            'link-css': resourceCategory(1, 16, 512),
            frame: resourceCategory(1, 36, 512),
            other: {
                totalObservedCount: null,
                totalDurationMs: null,
                transferSizeBytes: null,
                encodedBodySizeBytes: null,
                decodedBodySizeBytes: null,
                zeroTransferSizeCount: null,
                duration: null,
            },
        },
    })
    const hostFamily = ({ accepted = 4, retained = accepted, dropped = 0, rejected = 0, evidence = accepted } = {}) => ({
        acceptedSampleCount: accepted,
        retainedSampleCount: retained,
        droppedSampleCount: dropped,
        rejectedSampleCount: rejected,
        evidenceSampleCount: evidence,
        capacity: 64,
        truncated: dropped > 0,
        window: { startedAt: 0, endedAt: 10_000, durationMs: 10_000 },
    })
    Object.assign(snapshot.hostEvidence.renderer, {
        ...hostFamily({ accepted: 5, retained: 4, dropped: 1, rejected: 2 }),
        backends: ['canvas2d', 'webgl2'],
        evidenceBackends: ['canvas2d', 'webgl2'],
        drawCalls: statistics(17, 4),
        triangles: null,
        lines: statistics(0, 4),
        points: statistics(9, 4),
        geometries: null,
        textures: statistics(4, 4),
        programs: statistics(2, 4),
        gpuTimerCapability: 'supported',
        gpuFrameMs: statistics(2.5, 3),
        gpuMeasuredSampleCount: 3,
        gpuRejectedSampleCount: 1,
    })
    Object.assign(snapshot.hostEvidence.media, {
        ...hostFamily({ accepted: 8, retained: 8, evidence: 8 }),
        callbackIntervalMs: statistics(16.7, 8),
        presentedFramesDelta: statistics(1, 7),
        totalVideoFramesDelta: 200,
        droppedVideoFramesDelta: 6,
        playbackDropRatio: 0.03,
        playbackQualityMeasuredSampleCount: 7,
    })
    Object.assign(snapshot.hostEvidence.lifecycle, {
        ...hostFamily({ accepted: 4, retained: 4, evidence: 4 }),
        checkpoints: { mount: 1, 'after-interaction': 1, unmount: 1, manual: 1 },
        latestAnimationTotal: 12,
        latestActiveAnimationCount: 3,
        latestScrollTriggerTotal: 5,
        growthCandidate: null,
    })
    Object.assign(snapshot.hostEvidence.framework, {
        ...hostFamily({ accepted: 6, retained: 6, evidence: 6 }),
        frameworks: ['react'],
        renderMs: statistics(3.2, 6),
        commitMs: statistics(1.4, 6),
        updateWindowMs: statistics(8.5, 4),
        checkWindowMs: statistics(5.5, 3),
    })
    Object.assign(snapshot.hostEvidence.work, {
        ...hostFamily({ accepted: 7, retained: 7, evidence: 7 }),
        workMs: statistics(2, 7),
        categories: { script: 2, layout: 2, paint: 1, composite: 1, other: 1 },
    })
    snapshot.coverage.renderer = { status: 'partial', evidenceLevel: 'runtime-observation' }
    snapshot.coverage.resourcesMedia = { status: 'partial', evidenceLevel: 'runtime-observation' }
    snapshot.coverage.memoryLifecycle = { status: 'partial', evidenceLevel: 'runtime-observation' }
    snapshot.coverage.workAvoidance = { status: 'partial', evidenceLevel: 'runtime-observation' }
    Object.assign(snapshot.interactions.recent[0].performance.quality, {
        status: 'measured',
        acceptedSampleCount: 4,
        retainedSampleCount: 4,
        inputToVisual: statistics(22, 4),
        pointerSampleAge: statistics(7, 4),
        progressError: statistics(0.01, 4),
        domWebglAlignmentError: statistics(2, 4),
        controlWritersPerFrame: statistics(1, 4),
        controllerConflictSampleCount: 0,
        settleTime: statistics(120, 4),
        overshootRatio: statistics(0.1, 4),
        coalescedEventsAvailable: 4,
        coalescedEventsConsumed: 3,
        coalescedEventUtilization: 0.75,
    })
    Object.assign(snapshot.inputFrameScheduling, {
        status: 'measured',
        retainedCount: 4,
        totalObservedCount: 4,
        droppedSampleCount: 0,
        cancelledSampleCount: 0,
        pendingCount: 0,
        duration: statistics(9, 4),
        byKind: { pointer: 3, keyboard: 1, click: 0 },
    })
    Object.assign(snapshot.interactions.recent[0].performance.inputFrameScheduling, {
        status: 'measured',
        retainedCount: 4,
        totalObservedCount: 4,
        droppedSampleCount: 0,
        duration: statistics(9, 4),
    })

    const document = new FakeDocument()
    let overlaySnapshotIndex = 0
    const overlay = createAnimationDevOverlay(
        {
            state: 'running',
            snapshot() {
                const current = structuredClone(snapshot)
                current.capturedAt += overlaySnapshotIndex * 1_000
                current.frames.totalObservedCount += overlaySnapshotIndex * 30
                overlaySnapshotIndex += 1
                return current
            },
        },
        { document, production: false, initiallyOpen: true }
    )
    const shadow = document.body.children[0].shadowRoot
    const dock = shadow.children[1]
    const panel = dock.children[1]
    const issueButtons = findFakeNodes(panel, node => node.getAttribute('data-overlay-issue') !== null)

    assert.equal(issueButtons.length, 8)
    assert.equal(issueButtons[0].getAttribute('data-overlay-issue'), 'long-task-main-thread')
    assert.match(fakeNodeText(panel), /Motion Console/)
    assert.match(fakeNodeText(panel), /What to change/)
    assert.match(fakeNodeText(panel), /Verify the change/)
    assert.match(fakeNodeText(panel), /Regression checks/)
    const issueDetail = findFakeNodes(panel, node => node.className === 'detail-pane' && /What to change/.test(fakeNodeText(node)))[0]
    assert.ok(issueDetail)
    issueDetail.scrollTop = 140
    issueDetail.scrollLeft = 9
    overlay.refresh()
    assert.equal(issueDetail.scrollTop, 140)
    assert.equal(issueDetail.scrollLeft, 9)
    const refreshedIssueButtons = findFakeNodes(panel, node => node.getAttribute('data-overlay-issue') !== null)
    refreshedIssueButtons[1].click()
    assert.equal(issueDetail.scrollTop, 0)
    assert.equal(issueDetail.scrollLeft, 0)
    const captureEvidence = findFakeNodes(panel, node => node.getAttribute('data-overlay-capture-sufficiency') !== null)[0]
    assert.equal(captureEvidence.getAttribute('data-status'), 'insufficient')
    assert.match(fakeNodeText(captureEvidence), /Foreground 1.25 s/)
    assert.match(fakeNodeText(captureEvidence), /Background 500 ms/)
    assert.match(fakeNodeText(captureEvidence), /foreground window is shorter than 5 s/)
    assert.match(fakeNodeText(captureEvidence), /fewer than 30 retained frame samples/)
    const lcp = findFakeNodes(panel, node => node.getAttribute('data-web-vital') === 'LCP')[0]
    const inp = findFakeNodes(panel, node => node.getAttribute('data-web-vital') === 'INP')[0]
    const cls = findFakeNodes(panel, node => node.getAttribute('data-web-vital') === 'CLS')[0]
    assert.match(fakeNodeText(lcp), /good 1250 ms/)
    assert.equal(inp.getAttribute('data-observed'), 'false')
    assert.match(fakeNodeText(inp), /not observed unknown/)
    assert.doesNotMatch(fakeNodeText(inp), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(cls), /needs improvement 0\.08/)
    assert.match(fakeNodeText(panel), /document-lifetime · may predate this capture/)

    assert.equal(dock.getAttribute('data-layout'), 'wide')
    const layoutButton = findFakeNodes(panel, node => node.getAttribute('aria-label') === 'Use compact animation panel')[0]
    assert.ok(layoutButton)
    layoutButton.click()
    assert.equal(dock.getAttribute('data-layout'), 'compact')
    assert.equal(layoutButton.getAttribute('aria-pressed'), 'false')
    layoutButton.click()
    assert.equal(dock.getAttribute('data-layout'), 'wide')
    overlay.refresh()
    assert.match(fakeNodeText(panel), /30 FPS/)
    assert.match(fakeNodeText(panel), /60 Hz/)
    assert.match(fakeNodeText(panel), /Live rAF cadence/)
    assert.match(fakeNodeText(panel), /Input → next rAF proxy p95/)
    assert.match(fakeNodeText(panel), /4\/4 retained · Measured · 0 lost\/cancelled/)
    assert.match(fakeNodeText(panel), /LoAF render → paint p95/)
    assert.match(fakeNodeText(panel), /4\/4 valid retained · Measured/)
    assert.match(fakeNodeText(panel), /LoAF paint → presentation p95/)
    assert.match(fakeNodeText(panel), /3\/3 valid retained · Measured/)
    const loafPaintCard = findFakeNodes(panel, node => node.getAttribute('data-metric') === 'loaf-render-paint')[0]
    assert.match(loafPaintCard.getAttribute('title'), /does not cover every frame/)

    const interactionsTab = findFakeNodes(panel, node => node.getAttribute('data-overlay-tab') === 'interactions')[0]
    assert.ok(interactionsTab)
    interactionsTab.click()
    assert.equal(interactionsTab.getAttribute('aria-selected'), 'true')
    assert.match(fakeNodeText(panel), /gallery drag/)
    assert.match(fakeNodeText(panel), /Interpretation boundary/)
    const qualityFacts = findFakeNodes(panel, node => node.getAttribute('data-interaction-quality-metric') !== null)
    assert.equal(qualityFacts.length, 8)
    assert.match(fakeNodeText(panel), /Continuous interaction quality/)
    assert.match(fakeNodeText(panel), /Input → visual p95 22 ms/)
    assert.match(fakeNodeText(panel), /Pointer sample age p95 7 ms/)
    assert.match(fakeNodeText(panel), /Progress error p95 1%/)
    assert.match(fakeNodeText(panel), /DOM\/WebGL alignment p95 2 px/)
    assert.match(fakeNodeText(panel), /Control conflicts 0 conflict samples · max 1 writers/)
    assert.match(fakeNodeText(panel), /Settle time p95 120 ms/)
    assert.match(fakeNodeText(panel), /Overshoot p95 10%/)
    assert.match(fakeNodeText(panel), /Coalesced utilization 75% · 3\/4 events/)
    const scheduling = findFakeNodes(panel, node => node.getAttribute('data-input-frame-scheduling') !== null)[0]
    assert.ok(scheduling)
    assert.match(fakeNodeText(scheduling), /Input dispatch → next rAF callback/)
    assert.match(fakeNodeText(scheduling), /9 ms · Measured/)
    assert.match(fakeNodeText(scheduling), /4\/4 retained · 0 dropped · 0 cancelled · 0 pending/)
    assert.match(fakeNodeText(scheduling), /does not prove a visual update, paint, presentation, or GPU completion/)
    const interactionDetail = findFakeNodes(panel, node => node.className === 'detail-pane' && /gallery drag/.test(fakeNodeText(node)))[0]
    assert.ok(interactionDetail)
    interactionDetail.scrollTop = 120
    interactionDetail.scrollLeft = 7
    overlay.refresh()
    assert.equal(interactionDetail.scrollTop, 120)
    assert.equal(interactionDetail.scrollLeft, 7)

    const coverageTab = findFakeNodes(panel, node => node.getAttribute('data-overlay-tab') === 'coverage')[0]
    assert.ok(coverageTab)
    coverageTab.click()
    assert.equal(coverageTab.getAttribute('aria-selected'), 'true')
    const coverageRows = findFakeNodes(panel, node => node.getAttribute('data-coverage-family') !== null)
    assert.equal(coverageRows.length, 12)
    const rendererCoverage = coverageRows.find(node => node.getAttribute('data-coverage-family') === 'renderer')
    assert.ok(rendererCoverage)
    rendererCoverage.click()
    assert.equal(rendererCoverage.getAttribute('data-selected'), 'false')
    const selectedRendererCoverage = findFakeNodes(
        panel,
        node => node.getAttribute('data-coverage-family') === 'renderer' && node.getAttribute('data-selected') === 'true'
    )[0]
    assert.ok(selectedRendererCoverage)
    const rendererHostDetail = findFakeNodes(panel, node => node.getAttribute('data-host-evidence') === 'renderer')[0]
    assert.ok(rendererHostDetail)
    const rendererHostMetric = id => findFakeNodes(rendererHostDetail, node => node.getAttribute('data-host-evidence-metric') === id)[0]
    assert.match(fakeNodeText(rendererHostMetric('backend')), /Backend Canvas 2D · WebGL 2/)
    assert.match(fakeNodeText(rendererHostMetric('draw-calls-p95')), /Draw calls p95 17/)
    assert.match(fakeNodeText(rendererHostMetric('triangles-p95')), /Triangles p95 unknown/)
    assert.doesNotMatch(fakeNodeText(rendererHostMetric('triangles-p95')), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(rendererHostMetric('lines-p95')), /Lines p95 0/)
    assert.match(fakeNodeText(rendererHostMetric('points-p95')), /Points p95 9/)
    assert.match(fakeNodeText(rendererHostMetric('geometries-p95')), /Geometries p95 unknown/)
    assert.doesNotMatch(fakeNodeText(rendererHostMetric('geometries-p95')), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(rendererHostMetric('textures-p95')), /Textures p95 4/)
    assert.match(fakeNodeText(rendererHostMetric('programs-p95')), /Programs p95 2/)
    assert.match(fakeNodeText(rendererHostMetric('gpu-timer-capability')), /GPU timer capability Supported/)
    assert.match(fakeNodeText(rendererHostMetric('gpu-frame-p95')), /GPU frame p95 2\.50 ms/)
    assert.match(fakeNodeText(rendererHostMetric('gpu-rejected')), /GPU rejected samples 1/)
    assert.match(fakeNodeText(rendererHostMetric('retained-tail')), /Retained tail truncated/)
    assert.match(fakeNodeText(rendererHostMetric('accepted')), /Accepted samples 5/)
    assert.match(fakeNodeText(rendererHostMetric('dropped')), /Dropped samples 1/)
    assert.match(fakeNodeText(rendererHostMetric('rejected')), /Rejected samples 2/)
    assert.match(fakeNodeText(rendererHostDetail), /explicit host adapter · local only/i)
    assert.match(fakeNodeText(rendererHostDetail), /excluded from animation_rum v1/i)
    assert.match(fakeNodeText(panel), /Missing or unsupported evidence is never converted to zero/i)
    const coverageDetail = findFakeNodes(
        panel,
        node => node.className === 'detail-pane' && /Renderer host evidence/.test(fakeNodeText(node))
    )[0]
    assert.ok(coverageDetail)
    coverageDetail.scrollTop = 180
    coverageDetail.scrollLeft = 11
    overlay.refresh()
    assert.equal(coverageDetail.scrollTop, 180)
    assert.equal(coverageDetail.scrollLeft, 11)

    const resourcesCoverage = findFakeNodes(panel, node => node.getAttribute('data-coverage-family') === 'resourcesMedia')[0]
    resourcesCoverage.click()
    assert.equal(coverageDetail.scrollTop, 0)
    assert.equal(coverageDetail.scrollLeft, 0)
    const resourceDetail = findFakeNodes(panel, node => node.getAttribute('data-resource-timing') !== null)[0]
    assert.ok(resourceDetail)
    const resourceMetric = id => findFakeNodes(resourceDetail, node => node.getAttribute('data-resource-timing-metric') === id)[0]
    assert.match(fakeNodeText(resourceMetric('total-observed')), /Resource entries 17/)
    assert.match(fakeNodeText(resourceMetric('retained')), /Retained entries 12/)
    assert.match(fakeNodeText(resourceMetric('dropped')), /Dropped entries 5/)
    assert.match(fakeNodeText(resourceMetric('rejected')), /Rejected entries 2/)
    assert.match(fakeNodeText(resourceMetric('excluded-pre-capture')), /Excluded before capture 3/)
    assert.match(fakeNodeText(resourceMetric('duration-p95')), /Resource duration p95 42 ms/)
    assert.match(fakeNodeText(resourceMetric('transfer-bytes')), /Transfer bytes 8192 B/)
    assert.match(fakeNodeText(resourceMetric('encoded-bytes')), /Encoded bytes 4096 B/)
    assert.match(fakeNodeText(resourceMetric('decoded-bytes')), /Decoded bytes unknown/)
    assert.doesNotMatch(fakeNodeText(resourceMetric('decoded-bytes')), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(resourceMetric('zero-transfer')), /Zero-transfer entries 2/)
    assert.match(fakeNodeText(resourceMetric('buffer-full')), /Buffer-full events 1/)
    const resourceCategories = findFakeNodes(resourceDetail, node => node.getAttribute('data-resource-category') !== null)
    assert.equal(resourceCategories.length, 7)
    assert.match(
        fakeNodeText(resourceCategories.find(node => node.getAttribute('data-resource-category') === 'script')),
        /Script 4 resources · p95 18 ms · transfer 2048 B/
    )
    assert.match(
        fakeNodeText(resourceCategories.find(node => node.getAttribute('data-resource-category') === 'media')),
        /Media 2 resources · p95 120 ms · transfer 0 B/
    )
    const unknownCategory = resourceCategories.find(node => node.getAttribute('data-resource-category') === 'other')
    assert.match(fakeNodeText(unknownCategory), /Other unknown resources · p95 unknown · transfer unknown/)
    assert.doesNotMatch(fakeNodeText(unknownCategory), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(resourceDetail), /URL\/name removed/)
    assert.match(fakeNodeText(resourceDetail), /Media decode, dropped playback frames, and GPU upload remain separate adapter evidence/)
    const mediaHostDetail = findFakeNodes(panel, node => node.getAttribute('data-host-evidence') === 'media')[0]
    assert.ok(mediaHostDetail)
    const mediaHostMetric = id => findFakeNodes(mediaHostDetail, node => node.getAttribute('data-host-evidence-metric') === id)[0]
    assert.match(fakeNodeText(mediaHostMetric('callback-p95')), /rVFC callback interval p95 16\.7 ms/)
    assert.match(fakeNodeText(mediaHostMetric('presented-frames-delta-p95')), /Presented-frame delta p95 1/)
    assert.match(fakeNodeText(mediaHostMetric('dropped-video-frames')), /Dropped video frames 6/)
    assert.match(fakeNodeText(mediaHostMetric('total-video-frames')), /Total video frames 200/)
    assert.match(fakeNodeText(mediaHostMetric('playback-drop-ratio')), /Playback drop ratio 3%/)
    assert.match(fakeNodeText(mediaHostDetail), /valid baseline/)

    const lifecycleCoverage = findFakeNodes(panel, node => node.getAttribute('data-coverage-family') === 'memoryLifecycle')[0]
    lifecycleCoverage.click()
    const lifecycleHostDetail = findFakeNodes(panel, node => node.getAttribute('data-host-evidence') === 'lifecycle')[0]
    assert.ok(lifecycleHostDetail)
    const lifecycleHostMetric = id => findFakeNodes(lifecycleHostDetail, node => node.getAttribute('data-host-evidence-metric') === id)[0]
    assert.match(fakeNodeText(lifecycleHostMetric('animations')), /GSAP animations 12/)
    assert.match(fakeNodeText(lifecycleHostMetric('active-animations')), /Active animations 3/)
    assert.match(fakeNodeText(lifecycleHostMetric('scroll-triggers')), /ScrollTriggers 5/)
    assert.match(fakeNodeText(lifecycleHostMetric('checkpoints')), /Lifecycle checkpoints mount 1 · interaction 1 · unmount 1 · manual 1/)
    assert.match(fakeNodeText(lifecycleHostDetail), /Leak cannot be determined from checkpoints alone/)

    const workCoverage = findFakeNodes(panel, node => node.getAttribute('data-coverage-family') === 'workAvoidance')[0]
    workCoverage.click()
    const workHostDetail = findFakeNodes(panel, node => node.getAttribute('data-host-evidence') === 'work')[0]
    assert.ok(workHostDetail)
    const workHostMetric = id => findFakeNodes(workHostDetail, node => node.getAttribute('data-host-evidence-metric') === id)[0]
    assert.match(fakeNodeText(workHostMetric('framework-render-p95')), /Framework render p95 3\.20 ms/)
    assert.match(fakeNodeText(workHostMetric('framework-commit-p95')), /Framework commit p95 1\.40 ms/)
    assert.match(fakeNodeText(workHostMetric('framework-update-window-p95')), /Framework update window p95 8\.50 ms/)
    assert.match(fakeNodeText(workHostMetric('framework-check-window-p95')), /Framework check window p95 5\.50 ms/)
    assert.match(fakeNodeText(workHostMetric('total-work-samples')), /Total work samples 7/)
    assert.match(fakeNodeText(workHostMetric('work-categories')), /Work categories script 2 · layout 2 · paint 1 · composite 1 · other 1/)

    overlay.destroy()
    const chineseDocument = new FakeDocument()
    const chineseSnapshot = structuredClone(snapshot)
    chineseSnapshot.hostEvidence.lifecycle.latestActiveAnimationCount = null
    const chineseOverlay = createAnimationDevOverlay(
        { state: 'running', snapshot: () => structuredClone(chineseSnapshot) },
        { document: chineseDocument, production: false, initiallyOpen: true, locale: 'zh-CN' }
    )
    const chinesePanel = chineseDocument.body.children[0].shadowRoot.children[1].children[1]
    assert.match(fakeNodeText(chinesePanel), /如何修改/)
    assert.match(fakeNodeText(chinesePanel), /如何验证修改/)
    assert.match(fakeNodeText(chinesePanel), /回归检查/)
    assert.match(fakeNodeText(chinesePanel), /采集证据/)
    assert.match(fakeNodeText(chinesePanel), /前台 1\.25 秒/)
    assert.match(fakeNodeText(chinesePanel), /整个文档周期/)
    assert.match(fakeNodeText(chinesePanel), /未观测到 未知/)
    assert.match(fakeNodeText(chinesePanel), /输入 → 下一次 rAF 代理 p95/)
    assert.match(fakeNodeText(chinesePanel), /LoAF 渲染开始 → 绘制结束 p95/)
    assert.match(fakeNodeText(chinesePanel), /LoAF 绘制结束 → 屏幕呈现 p95/)
    assert.match(fakeNodeText(chinesePanel), /不证明视觉更新、绘制、屏幕呈现或 GPU 已完成/)
    const chineseCoverageTab = findFakeNodes(chinesePanel, node => node.getAttribute('data-overlay-tab') === 'coverage')[0]
    chineseCoverageTab.click()
    const chineseRendererCoverage = findFakeNodes(chinesePanel, node => node.getAttribute('data-coverage-family') === 'renderer')[0]
    chineseRendererCoverage.click()
    const chineseRendererHostDetail = findFakeNodes(chinesePanel, node => node.getAttribute('data-host-evidence') === 'renderer')[0]
    assert.match(fakeNodeText(chineseRendererHostDetail), /线段数量 p95 0/)
    assert.match(fakeNodeText(chineseRendererHostDetail), /几何体数量 p95 未知/)
    assert.match(fakeNodeText(chineseRendererHostDetail), /GPU 拒绝样本 1/)
    assert.match(fakeNodeText(chineseRendererHostDetail), /保留尾窗 已截断/)
    const chineseResourcesCoverage = findFakeNodes(chinesePanel, node => node.getAttribute('data-coverage-family') === 'resourcesMedia')[0]
    chineseResourcesCoverage.click()
    const chineseResourceDetail = findFakeNodes(chinesePanel, node => node.getAttribute('data-resource-timing') !== null)[0]
    assert.match(fakeNodeText(chineseResourceDetail), /采集窗口内的 Resource Timing/)
    assert.match(fakeNodeText(chineseResourceDetail), /资源条目 17/)
    assert.match(fakeNodeText(chineseResourceDetail), /解码体积 未知/)
    assert.match(fakeNodeText(chineseResourceDetail), /脚本 共 4 个 · p95 18 ms · 传输 2048 B/)
    assert.match(fakeNodeText(chineseResourceDetail), /媒体解码、播放掉帧和 GPU 上传仍需单独的适配器证据/)
    const chineseMediaHostDetail = findFakeNodes(chinesePanel, node => node.getAttribute('data-host-evidence') === 'media')[0]
    assert.match(fakeNodeText(chineseMediaHostDetail), /视频宿主证据/)
    assert.match(fakeNodeText(chineseMediaHostDetail), /播放掉帧比例 3%/)
    const chineseLifecycleCoverage = findFakeNodes(chinesePanel, node => node.getAttribute('data-coverage-family') === 'memoryLifecycle')[0]
    chineseLifecycleCoverage.click()
    const chineseLifecycleHostDetail = findFakeNodes(chinesePanel, node => node.getAttribute('data-host-evidence') === 'lifecycle')[0]
    const chineseActiveMetric = findFakeNodes(
        chineseLifecycleHostDetail,
        node => node.getAttribute('data-host-evidence-metric') === 'active-animations'
    )[0]
    assert.match(fakeNodeText(chineseActiveMetric), /活动动画数 未知/)
    assert.doesNotMatch(fakeNodeText(chineseActiveMetric), /\b0(?:\.0+)?\b/)
    assert.match(fakeNodeText(chineseLifecycleHostDetail), /仅凭检查点尚不能判断泄漏/)
    assert.match(fakeNodeText(chineseLifecycleHostDetail), /不属于 animation_rum v1/)
    const chineseWorkCoverage = findFakeNodes(chinesePanel, node => node.getAttribute('data-coverage-family') === 'workAvoidance')[0]
    chineseWorkCoverage.click()
    const chineseWorkHostDetail = findFakeNodes(chinesePanel, node => node.getAttribute('data-host-evidence') === 'work')[0]
    assert.match(fakeNodeText(chineseWorkHostDetail), /框架更新窗口 p95 8\.50 ms/)
    const chineseInteractionsTab = findFakeNodes(chinesePanel, node => node.getAttribute('data-overlay-tab') === 'interactions')[0]
    chineseInteractionsTab.click()
    assert.match(fakeNodeText(chinesePanel), /连续交互质量/)
    assert.match(fakeNodeText(chinesePanel), /输入 → 视觉 p95 22 ms/)
    assert.match(fakeNodeText(chinesePanel), /合并事件利用率 75% · 3\/4 个事件/)
    assert.doesNotMatch(fakeNodeText(chinesePanel), /What to change/)
    chineseOverlay.destroy()
    collector.destroy()
})

test('dev overlay target recording is explicitly started, bounded, resettable, and cleared locally', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 16, 16])
    const before = collector.snapshot()
    const document = new FakeDocument()
    let requestedAnimationFrames = 0
    document.defaultView.requestAnimationFrame = callback => {
        requestedAnimationFrames += 1
        callback(runtime.now())
        return requestedAnimationFrames
    }
    document.defaultView.cancelAnimationFrame = () => {}
    const target = document.createElement('div')
    target.namespaceURI = 'http://www.w3.org/1999/xhtml'
    target.getAnimations = () => [
        {
            playState: 'running',
            pending: false,
            playbackRate: 1,
            effect: {
                getTiming: () => ({ duration: 180, delay: 0, iterations: 1 }),
                getKeyframes: () => [{ transform: 'translateY(10px)', opacity: 0 }],
            },
        },
    ]
    document.hit = target
    let targetSelection = null
    let targetSelectionOptions = null
    let rendererWindow = { startedAt: runtime.now(), endedAt: runtime.now() }
    const rendererAdapter = {
        id: 'overlay-renderer',
        version: '1.0.0',
        canInspect: element => element === target,
        inspect: () => ({
            renderer: {
                family: 'webgl',
                capability: { state: 'supported', observed: true, buffered: false },
                metrics: { cpuFrameMsP95: 2, gpuFrameMsP95: 3, drawCallsP95: 10 },
                evidence: {
                    window: rendererWindow,
                    acceptedSampleCount: 6,
                    retainedSampleCount: 5,
                    droppedSampleCount: 1,
                    rejectedSampleCount: 2,
                    gpu: { valid: true, disjoint: false, contextLost: false, source: 'host-summary' },
                },
            },
        }),
    }
    const overlay = createAnimationDevOverlay(
        {
            get state() {
                return collector.state
            },
            snapshot: () => collector.snapshot(),
            selectElement(element, options) {
                targetSelectionOptions = options
                targetSelection = collector.selectElement(element, options)
                return targetSelection
            },
        },
        { document, production: false, initiallyOpen: true, locale: 'en', targetAdapters: [rendererAdapter] }
    )
    const host = document.body.children[0]
    const dock = host.shadowRoot.children[1]
    const panel = dock.children[1]
    const targetAction = action => findFakeNodes(panel, node => node.getAttribute('data-target-recording-action') === action)[0]
    const pickerButton = findFakeNodes(panel, node => node.getAttribute('data-animation-target-picker') !== null)[0]
    assert.ok(pickerButton)
    assert.equal(overlay.targetState, 'idle')

    pickerButton.click()
    assert.equal(overlay.targetState, 'picking')
    assert.equal(overlay.expanded, false)
    const down = document.dispatchCaptured('pointerdown')
    const click = document.dispatchCaptured('click')
    assert.equal(down.prevented, true)
    assert.equal(click.stopped, true)
    assert.equal(overlay.expanded, true)
    assert.equal(overlay.targetState, 'selected')
    assert.equal(requestedAnimationFrames, 0)
    assert.ok(targetSelection)
    assert.equal(targetSelectionOptions.inspectionPurpose, 'local')
    const selected = targetSelection.snapshot()
    assert.equal(selected.state, 'selected')
    assert.equal(selected.activeInteractionId, null)
    assert.equal(selected.correlated, null)
    const targetTab = findFakeNodes(panel, node => node.getAttribute('data-overlay-tab') === 'target')[0]
    assert.equal(targetTab.getAttribute('aria-selected'), 'true')
    assert.match(fakeNodeText(panel), /Direct element evidence/)
    assert.match(fakeNodeText(panel), /Page window during selection/)
    assert.match(fakeNodeText(panel), /not part of animation_rum v1/)
    assert.match(fakeNodeText(panel), /Evidence window 0 ms/)
    assert.match(fakeNodeText(panel), /Samples \(accepted \/ retained \/ dropped \/ rejected\) 6 \/ 5 \/ 1 \/ 2/)
    assert.match(fakeNodeText(panel), /Retained tail truncated/)
    assert.match(fakeNodeText(panel), /GPU timing valid evidence/)

    const startButton = targetAction('start')
    assert.ok(startButton)
    assert.equal(startButton.disabled, false)
    assert.equal(targetAction('stop').disabled, true)
    assert.equal(targetAction('reset').disabled, true)
    startButton.click()
    const recording = targetSelection.snapshot()
    assert.equal(overlay.targetState, 'recording')
    assert.equal(recording.state, 'recording')
    assert.ok(recording.activeInteractionId)
    assert.equal(recording.correlated, null)

    runtime.tick(25)
    rendererWindow = { startedAt: rendererWindow.startedAt, endedAt: runtime.now() }
    const firstInteractionId = recording.activeInteractionId
    const stopButton = targetAction('stop')
    assert.ok(stopButton)
    assert.equal(stopButton.disabled, false)
    stopButton.click()
    const stopped = targetSelection.snapshot()
    assert.equal(overlay.targetState, 'selected')
    assert.equal(stopped.state, 'selected')
    assert.equal(stopped.activeInteractionId, null)
    assert.ok(stopped.correlated)
    assert.equal(stopped.correlationRelation, 'temporal-overlap')
    assert.equal(stopped.correlatedDurationMs, 25)
    const correlatedAtStop = structuredClone(stopped.correlated)
    const durationAtStop = collector.snapshot().interactions.recent.find(interaction => interaction.id === firstInteractionId).durationMs

    runtime.tick(80)
    const targetDetail = findFakeNodes(
        panel,
        node => node.className === 'detail-pane' && /Direct element evidence/.test(fakeNodeText(node))
    )[0]
    assert.ok(targetDetail)
    targetDetail.scrollTop = 160
    targetDetail.scrollLeft = 12
    overlay.refresh()
    assert.equal(targetDetail.scrollTop, 160)
    assert.equal(targetDetail.scrollLeft, 12)
    assert.deepEqual(targetSelection.snapshot().correlated, correlatedAtStop)
    assert.equal(
        collector.snapshot().interactions.recent.find(interaction => interaction.id === firstInteractionId).durationMs,
        durationAtStop
    )

    const resetButton = targetAction('reset')
    assert.ok(resetButton)
    assert.equal(resetButton.disabled, false)
    resetButton.click()
    const reset = targetSelection.snapshot()
    assert.equal(reset.state, 'recording')
    assert.ok(reset.activeInteractionId)
    assert.notEqual(reset.activeInteractionId, firstInteractionId)
    assert.equal(reset.correlated, null)

    runtime.tick(15)
    const resetInteractionId = reset.activeInteractionId
    const clearButton = targetAction('clear')
    assert.ok(clearButton)
    targetDetail.scrollTop = 100
    targetDetail.scrollLeft = 8
    clearButton.click()
    assert.equal(targetDetail.scrollTop, 0)
    assert.equal(targetDetail.scrollLeft, 0)
    assert.equal(overlay.targetState, 'idle')
    assert.equal(targetSelection.state, 'cleared')
    assert.throws(() => targetSelection.snapshot(), /cleared element selection/)
    assert.match(fakeNodeText(panel), /No selected target/)
    const after = collector.snapshot()
    assert.equal(after.captureId, before.captureId)
    assert.ok(after.frames.totalObservedCount > before.frames.totalObservedCount)
    assert.equal(after.interactions.activeCount, 0)
    assert.equal(after.interactions.recent.find(interaction => interaction.id === resetInteractionId).outcome, 'cancelled')
    assert.equal(collector.state, 'running')
    overlay.destroy()
    assert.equal(document.listeners.size, 0)
    collector.destroy()
})

test('dev overlay auto-detects Chinese and lets the developer switch language locally', () => {
    const runtime = new FakeRuntime()
    const collector = new AnimationCollector({ runtime }).start()
    collectFrames(runtime, [16, 32, 48])
    const document = new FakeDocument()
    document.documentElement.setAttribute('lang', 'zh-CN')
    const overlay = createAnimationDevOverlay(collector, { document, production: false, initiallyOpen: true })
    const host = document.body.children[0]
    const panel = host.shadowRoot.children[1].children[1]

    assert.equal(host.getAttribute('lang'), 'zh-CN')
    assert.match(fakeNodeText(panel), /动效性能控制台/)
    assert.match(fakeNodeText(panel), /近实时帧率（rAF）/)
    assert.match(fakeNodeText(panel), /问题列表/)
    const localeButton = findFakeNodes(panel, node => node.getAttribute('data-overlay-locale-toggle') !== null)[0]
    assert.ok(localeButton)
    assert.equal(localeButton.textContent, 'EN')

    localeButton.click()
    assert.equal(host.getAttribute('lang'), 'en')
    assert.match(fakeNodeText(panel), /Motion Console/)
    assert.match(fakeNodeText(panel), /Live rAF cadence/)

    overlay.destroy()
    collector.destroy()
})

test('collector rejects SSR while integration lifecycle safely no-ops', () => {
    const runtime = new FakeRuntime({ browser: false })
    assert.throws(() => new AnimationCollector({ runtime }).start(), AnimationUnsupportedError)
    const transport = {
        reports: [],
        send(report) {
            this.reports.push(report)
        },
    }
    const integration = new AnimationIntegration({
        runtime,
        rum: { enabled: true, sampleRate: 1, sampleKey: 'server-render' },
    })
    const teardown = integration.setup(transport)
    assert.equal(integration.collector.state, 'idle')
    teardown()
    assert.equal(integration.collector.state, 'destroyed')
    assert.equal(transport.reports.length, 0)
})

test('browser runtime forwards shared observer capability and buffered fallback evidence', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalObserver = globalThis.PerformanceObserver
    const fakeWindow = {
        requestAnimationFrame() {
            return 1
        },
        cancelAnimationFrame() {},
        addEventListener() {},
        removeEventListener() {},
    }
    const fakeDocument = {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {},
    }
    globalThis.window = fakeWindow
    globalThis.document = fakeDocument

    try {
        class SupportedWithoutList {
            static supportedEntryTypes = undefined
            static instance
            constructor(callback) {
                this.callback = callback
                SupportedWithoutList.instance = this
            }
            observe(options) {
                this.options = options
            }
            emit(droppedEntriesCount) {
                this.callback({ getEntries: () => [] }, this, { droppedEntriesCount })
            }
            disconnect() {}
        }
        globalThis.PerformanceObserver = SupportedWithoutList
        const supportedRuntime = createBrowserAnimationRuntime()
        const supported = supportedRuntime.observePerformance('longtask', () => {})
        assert.equal(supported.state, 'supported')
        assert.equal(supported.buffered, true)
        assert.equal(supported.reason, undefined)
        assert.equal(supported.droppedEntriesCount, null)
        SupportedWithoutList.instance.emit(2)
        assert.equal(supported.droppedEntriesCount, 2)
        supported.disconnect()

        class LegacyFallbackObserver {
            static supportedEntryTypes = undefined
            observe(options) {
                if ('type' in options) throw new Error('legacy signature only')
                this.options = options
            }
            disconnect() {}
        }
        globalThis.PerformanceObserver = LegacyFallbackObserver
        const fallbackRuntime = createBrowserAnimationRuntime()
        const fallback = fallbackRuntime.observePerformance('longtask', () => {})
        assert.equal(fallback.state, 'supported')
        assert.equal(fallback.buffered, false)
        fallback.disconnect()

        class DrainingObserver {
            static supportedEntryTypes = ['longtask']
            static instances = []

            constructor() {
                this.records = []
                DrainingObserver.instances.push(this)
            }

            observe() {}

            takeRecords() {
                const records = this.records
                this.records = []
                return records
            }

            disconnect() {}
        }
        globalThis.PerformanceObserver = DrainingObserver
        const drainingRuntime = createBrowserAnimationRuntime()
        const delivered = []
        const draining = drainingRuntime.observePerformance('longtask', entries => delivered.push(...entries))
        DrainingObserver.instances[0].records.push({ entryType: 'longtask', name: 'self', startTime: 5, duration: 60 })
        drainingRuntime.drainPendingPerformanceEntries()
        assert.deepEqual(delivered, [{ startTime: 5, duration: 60 }])
        draining.disconnect()
    } finally {
        if (originalWindow === undefined) delete globalThis.window
        else globalThis.window = originalWindow
        if (originalDocument === undefined) delete globalThis.document
        else globalThis.document = originalDocument
        if (originalObserver === undefined) delete globalThis.PerformanceObserver
        else globalThis.PerformanceObserver = originalObserver
    }
})
