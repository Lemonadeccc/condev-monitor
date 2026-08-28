import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore uninspected

import { createMotionSemanticCheckpointRecorder } from '../build/esm/index.mjs'

function quality(overrides = {}) {
    return {
        status: 'measured',
        acceptedSampleCount: 1,
        retainedSampleCount: 1,
        droppedSampleCount: 0,
        rejectedSampleCount: 0,
        capacity: 8,
        inputToVisual: { count: 1, p50: 12, p75: 12, p95: 12, p99: 12, max: 12, total: 12 },
        pointerSampleAge: null,
        progressError: null,
        domWebglAlignmentError: null,
        controlWritersPerFrame: null,
        controllerConflictSampleCount: 0,
        settleTime: null,
        overshootRatio: null,
        oscillationCount: null,
        coalescedEventsAvailable: 0,
        coalescedEventsConsumed: 0,
        coalescedEventUtilization: null,
        ...overrides,
    }
}

function hostStats(count, value) {
    return count === 0 ? null : { count, p50: value, p75: value, p95: value, p99: value, min: value, max: value, total: count * value }
}

function interactionFactory() {
    let sequence = 0
    const calls = { begin: 0, end: 0, cancel: 0, quality: 0 }
    return {
        calls,
        begin(kind, label = kind) {
            calls.begin += 1
            sequence += 1
            const interactionSequence = sequence
            let result = null
            const settle = outcome => {
                if (result) return result
                calls[outcome === 'completed' ? 'end' : 'cancel'] += 1
                result = {
                    id: `interaction-${interactionSequence}`,
                    kind,
                    label,
                    startedAt: interactionSequence * 100,
                    endedAt: interactionSequence * 100 + 25,
                    durationMs: 25,
                    outcome,
                    performance: { quality: quality() },
                }
                return result
            }
            return {
                id: `interaction-${interactionSequence}`,
                kind,
                recordQuality() {
                    if (result) return false
                    calls.quality += 1
                    return true
                },
                end: () => settle('completed'),
                cancel: () => settle('cancelled'),
            }
        },
    }
}

function tickerSnapshot(acceptedTickCount) {
    return {
        status: 'observing',
        running: true,
        cleanupFailed: false,
        acceptedTickCount,
        retainedTickCount: acceptedTickCount,
        droppedTickCount: 0,
        rejectedTickCount: 0,
        capacity: 8,
        truncated: false,
        slowTickThresholdMs: null,
        slowTickTotalObservedCount: null,
        deltaTimeMs: acceptedTickCount === 0 ? null : { count: acceptedTickCount, p50: 16, p75: 16, p95: 17, p99: 17, max: 17, total: 17 },
        privateHost: 'must-not-survive-projection',
    }
}

function lenisSnapshot(acceptedEventCount) {
    return {
        status: 'observing',
        running: true,
        cleanupFailed: false,
        acceptedEventCount,
        retainedEventCount: acceptedEventCount,
        droppedEventCount: 0,
        rejectedEventCount: 0,
        capacity: 8,
        truncated: false,
        scrollStateTotalObservedCounts: { smooth: acceptedEventCount, native: 0, idle: 0 },
        directionTotalObservedCounts: { negative: 0, zero: 0, positive: acceptedEventCount },
        progress: hostStats(acceptedEventCount, 0.75),
        velocity: hostStats(acceptedEventCount, 2.5),
        lastVelocity: hostStats(acceptedEventCount, 2),
        latestObservedLenisTimeMs: acceptedEventCount === 0 ? null : 120,
    }
}

function scrollTriggerCapture(totalTriggerCount = 2) {
    return {
        reason: 'manual',
        timestampMs: 15,
        totalTriggerCount,
        inspectedTriggerCount: totalTriggerCount,
        uninspectedTriggerCount: 0,
        triggerListTruncated: false,
        rejectedTriggerCount: 0,
        rejectedFieldCount: 0,
        activeStateSampleCount: totalTriggerCount,
        activeTriggerCount: 1,
        inactiveTriggerCount: Math.max(0, totalTriggerCount - 1),
        directionSampleCount: totalTriggerCount,
        directionCounts: { negative: 0, zero: 0, positive: totalTriggerCount },
        progress: hostStats(totalTriggerCount, 0.8),
        velocityPxPerSecond: hostStats(totalTriggerCount, 240),
        spanPx: hostStats(totalTriggerCount, 600),
        selector: '#private-target',
    }
}

test('correlates only explicit business interactions with closed local motion evidence', () => {
    const interaction = interactionFactory()
    let now = 0
    let tickerReads = 0
    let lenisReads = 0
    let scrollTriggerReads = 0
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction: interaction.begin,
        now: () => (now += 5),
        gsapTicker: { snapshot: () => tickerSnapshot((tickerReads += 1)) },
        lenisScroll: { snapshot: () => lenisSnapshot((lenisReads += 1)) },
        scrollTrigger: {
            capture() {
                scrollTriggerReads += 1
                return scrollTriggerCapture()
            },
        },
    })

    const active = recorder.begin('scroll', 'gallery-scroll')
    assert.equal(active.recordQuality({ progressError: 0.05 }), true)
    const result = active.end()

    assert.equal(result.measurement.outcome, 'completed')
    assert.deepEqual([result.semantic.before.boundary, result.semantic.after.boundary], ['before-interaction', 'after-interaction'])
    assert.deepEqual([result.semantic.before.status, result.semantic.after.status], ['measured', 'measured'])
    assert.equal(result.semantic.after.gsapTicker.deltaTimeMsP95, 17)
    assert.equal(result.semantic.after.lenisScroll.progressP95, 0.75)
    assert.equal(result.semantic.after.scrollTrigger.velocityPxPerSecondP95, 240)
    assert.equal(result.semantic.quality.inputToVisual.p95, 12)
    assert.deepEqual([tickerReads, lenisReads, scrollTriggerReads], [2, 2, 2])
    assert.equal(JSON.stringify(result.semantic).includes('privateHost'), false)
    assert.equal(JSON.stringify(result.semantic).includes('private-target'), false)
    assert.equal(JSON.stringify(result.semantic).includes('gallery-scroll'), false)
    assert.throws(() => {
        result.semantic.quality.inputToVisual.p95 = 999
    }, TypeError)
    assert.deepEqual(recorder.snapshot(), {
        status: 'active',
        capacity: 64,
        maximumActiveInteractions: 32,
        begunInteractionCount: 1,
        retainedInteractionCount: 1,
        droppedInteractionCount: 0,
        activeInteractionCount: 0,
        completedInteractionCount: 1,
        cancelledInteractionCount: 0,
        abandonedInteractionCount: 0,
        sourceReadErrorCount: 0,
        cleanupFailed: false,
        cleanupFailureCount: 0,
        truncated: false,
        interactions: [result.semantic],
    })
    assert.equal(active.end(), result)
    assert.equal(interaction.calls.end, 1)
})

test('keeps absent, unobserved, and failed sources explicit without throwing into application code', () => {
    const interaction = interactionFactory()
    let reads = 0
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction: interaction.begin,
        gsapTicker: { snapshot: () => tickerSnapshot(0) },
        scrollTrigger: {
            capture() {
                reads += 1
                if (reads === 1) throw new Error('host read failed')
                return null
            },
        },
    })

    const result = recorder.begin('pointer').cancel()
    assert.deepEqual(result.semantic.before.sourceStatus, {
        'gsap-ticker': 'not-observed',
        'lenis-scroll': 'not-configured',
        'scroll-trigger': 'error',
    })
    assert.equal(result.semantic.before.status, 'not-observed')
    assert.equal(result.semantic.before.errorSourceCount, 1)
    assert.equal(result.semantic.after.sourceStatus['scroll-trigger'], 'not-observed')
    assert.equal(recorder.snapshot().sourceReadErrorCount, 1)
    assert.equal(result.measurement.outcome, 'cancelled')
})

test('bounds retained semantic interactions and cancels only open monitoring windows on disposal', () => {
    const interaction = interactionFactory()
    const recorder = createMotionSemanticCheckpointRecorder({ beginInteraction: interaction.begin, capacity: 2 })

    recorder.begin('pointer').end()
    recorder.begin('drag').end()
    const open = recorder.begin('gesture')
    assert.equal(recorder.snapshot().activeInteractionCount, 1)

    recorder.dispose()
    recorder.dispose()
    const snapshot = recorder.snapshot()
    assert.deepEqual(
        snapshot.interactions.map(item => item.kind),
        ['drag', 'gesture']
    )
    assert.equal(snapshot.status, 'disposed')
    assert.equal(snapshot.begunInteractionCount, 3)
    assert.equal(snapshot.completedInteractionCount, 2)
    assert.equal(snapshot.cancelledInteractionCount, 1)
    assert.equal(snapshot.droppedInteractionCount, 1)
    assert.equal(snapshot.truncated, true)
    assert.equal(interaction.calls.cancel, 1)
    assert.equal(open.recordQuality({ settleTimeMs: 10 }), false)
    assert.equal(open.cancel().semantic.outcome, 'cancelled')
    assert.throws(() => recorder.begin('scroll'), /disposal started/)
})

test('rejects malformed interaction handles before retaining semantic state', () => {
    const recorder = createMotionSemanticCheckpointRecorder({ beginInteraction: () => ({}) })
    assert.throws(() => recorder.begin('custom'), /invalid animation interaction handle/)
    assert.equal(recorder.snapshot().begunInteractionCount, 0)
})

test('normalizes settlement and quality into a strict closed local summary', () => {
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction(kind) {
            const id = 'closed-interaction'
            return {
                id,
                kind,
                recordQuality: () => true,
                end: () => ({
                    id,
                    kind,
                    label: 'must-not-survive',
                    startedAt: 10,
                    endedAt: 20,
                    durationMs: 10,
                    outcome: 'completed',
                    secretMetadata: 'must-not-survive',
                    performance: {
                        quality: quality({ secretQuality: 'must-not-survive' }),
                    },
                }),
                cancel: () => {
                    throw new Error('not used')
                },
            }
        },
    })

    const result = recorder.begin('custom', 'private-label').end()
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('private-label'), false)
    assert.equal(serialized.includes('must-not-survive'), false)
    assert.deepEqual(Object.keys(result.measurement), ['id', 'kind', 'startedAt', 'endedAt', 'durationMs', 'outcome', 'quality'])
})

test('rejects invalid or mismatched settlement without retaining or miscounting it', () => {
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction(kind) {
            return {
                id: 'invalid-settlement',
                kind,
                recordQuality: () => true,
                end: () => ({
                    id: 'invalid-settlement',
                    kind,
                    startedAt: 20,
                    endedAt: 10,
                    durationMs: -10,
                    outcome: 'abandoned',
                    performance: { quality: quality() },
                }),
                cancel: () => ({
                    id: 'invalid-settlement',
                    kind,
                    startedAt: 0,
                    endedAt: 1,
                    durationMs: 1,
                    outcome: 'cancelled',
                    performance: { quality: quality() },
                }),
            }
        },
    })

    const active = recorder.begin('custom')
    assert.throws(() => active.end(), /invalid measurement/)
    assert.deepEqual(recorder.snapshot(), {
        status: 'active',
        capacity: 64,
        maximumActiveInteractions: 32,
        begunInteractionCount: 1,
        retainedInteractionCount: 0,
        droppedInteractionCount: 0,
        activeInteractionCount: 1,
        completedInteractionCount: 0,
        cancelledInteractionCount: 0,
        abandonedInteractionCount: 0,
        sourceReadErrorCount: 0,
        cleanupFailed: false,
        cleanupFailureCount: 0,
        truncated: false,
        interactions: [],
    })
    assert.equal(active.cancel().measurement.outcome, 'cancelled')
})

test('downgrades internally contradictory observer snapshots to source errors', () => {
    const interaction = interactionFactory()
    const malformedTicker = { ...tickerSnapshot(1), status: 'unsupported', retainedTickCount: 0, droppedTickCount: 1, truncated: true }
    const malformedLenis = { ...lenisSnapshot(1), retainedEventCount: 0, droppedEventCount: 0 }
    const malformedScrollTrigger = {
        ...scrollTriggerCapture(1),
        inspectedTriggerCount: 100,
        uninspectedTriggerCount: 200,
        triggerListTruncated: false,
    }
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction: interaction.begin,
        gsapTicker: { snapshot: () => malformedTicker },
        lenisScroll: { snapshot: () => malformedLenis },
        scrollTrigger: { capture: () => malformedScrollTrigger },
    })

    const result = recorder.begin('scroll').end()
    assert.deepEqual(result.semantic.before.sourceStatus, {
        'gsap-ticker': 'error',
        'lenis-scroll': 'error',
        'scroll-trigger': 'error',
    })
    assert.equal(result.semantic.before.errorSourceCount, 3)
    assert.equal(result.semantic.before.status, 'not-observed')
})

test('rejects negative progress and span evidence while preserving signed velocity', () => {
    const interaction = interactionFactory()
    const negativeLenisProgress = { ...lenisSnapshot(1), progress: hostStats(1, -0.5), velocity: hostStats(1, -2) }
    const negativeScrollTriggerRange = {
        ...scrollTriggerCapture(1),
        progress: hostStats(1, -0.5),
        velocityPxPerSecond: hostStats(1, -240),
        spanPx: hostStats(1, -100),
    }
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction: interaction.begin,
        lenisScroll: { snapshot: () => negativeLenisProgress },
        scrollTrigger: { capture: () => negativeScrollTriggerRange },
    })

    const result = recorder.begin('scroll').end()
    assert.equal(result.semantic.before.sourceStatus['lenis-scroll'], 'error')
    assert.equal(result.semantic.before.sourceStatus['scroll-trigger'], 'error')
    assert.equal(result.semantic.before.lenisScroll, null)
    assert.equal(result.semantic.before.scrollTrigger, null)
})

test('seals input immediately when disposal cleanup fails and supports an explicit retry', () => {
    let cancelAttempts = 0
    let recorder
    const beginInteraction = kind => ({
        id: 'retryable-interaction',
        kind,
        recordQuality: () => true,
        end: () => {
            throw new Error('not used')
        },
        cancel: () => {
            cancelAttempts += 1
            assert.throws(() => recorder.begin('pointer'), /disposal started/)
            if (cancelAttempts === 1) throw new Error('transient cleanup failure')
            return {
                id: 'retryable-interaction',
                kind,
                startedAt: 0,
                endedAt: 1,
                durationMs: 1,
                outcome: 'cancelled',
                performance: { quality: quality() },
            }
        },
    })
    recorder = createMotionSemanticCheckpointRecorder({ beginInteraction })
    const active = recorder.begin('pointer')

    recorder.dispose()
    assert.deepEqual(recorder.snapshot(), {
        status: 'dispose-failed',
        capacity: 64,
        maximumActiveInteractions: 32,
        begunInteractionCount: 1,
        retainedInteractionCount: 0,
        droppedInteractionCount: 0,
        activeInteractionCount: 1,
        completedInteractionCount: 0,
        cancelledInteractionCount: 0,
        abandonedInteractionCount: 0,
        sourceReadErrorCount: 0,
        cleanupFailed: true,
        cleanupFailureCount: 1,
        truncated: false,
        interactions: [],
    })
    assert.equal(active.recordQuality({ settleTimeMs: 1 }), false)

    recorder.dispose()
    assert.equal(cancelAttempts, 2)
    assert.deepEqual(recorder.snapshot(), {
        status: 'disposed',
        capacity: 64,
        maximumActiveInteractions: 32,
        begunInteractionCount: 1,
        retainedInteractionCount: 1,
        droppedInteractionCount: 0,
        activeInteractionCount: 0,
        completedInteractionCount: 0,
        cancelledInteractionCount: 1,
        abandonedInteractionCount: 0,
        sourceReadErrorCount: 0,
        cleanupFailed: false,
        cleanupFailureCount: 1,
        truncated: false,
        interactions: [active.cancel().semantic],
    })
})

test('rejects excess active windows before opening another collector interaction', () => {
    const interaction = interactionFactory()
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction: interaction.begin,
        maximumActiveInteractions: 2,
    })
    const first = recorder.begin('pointer')
    const second = recorder.begin('drag')
    assert.throws(() => recorder.begin('scroll'), /Cannot exceed 2/)
    assert.equal(interaction.calls.begin, 2)
    first.cancel()
    second.cancel()
})

test('compensates a handle created by a reentrant dispose and keeps failed cleanup retryable', () => {
    let recorder
    let cancelAttempts = 0
    recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction(kind) {
            recorder.dispose()
            return {
                id: 'reentrant-begin',
                kind,
                recordQuality: () => true,
                end: () => {
                    throw new Error('not used')
                },
                cancel: () => {
                    cancelAttempts += 1
                    if (cancelAttempts === 1) throw new Error('transient compensation failure')
                    return {
                        id: 'reentrant-begin',
                        kind,
                        startedAt: 0,
                        endedAt: 1,
                        durationMs: 1,
                        outcome: 'cancelled',
                        performance: { quality: quality() },
                    }
                },
            }
        },
    })

    assert.throws(() => recorder.begin('pointer'), /creation was aborted/)
    assert.equal(cancelAttempts, 1)
    assert.match(recorder.snapshot().status, /dispose-failed/)
    assert.equal(recorder.snapshot().activeInteractionCount, 1)

    recorder.dispose()
    assert.equal(cancelAttempts, 2)
    assert.equal(recorder.snapshot().status, 'disposed')
    assert.equal(recorder.snapshot().activeInteractionCount, 0)
    assert.equal(recorder.snapshot().begunInteractionCount, 0)
})

test('does not claim disposal when a malformed reentrant handle cannot be cleaned immediately', () => {
    let recorder
    let cancelAttempts = 0
    recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction() {
            recorder.dispose()
            return {
                cancel() {
                    cancelAttempts += 1
                    if (cancelAttempts === 1) throw new Error('temporary malformed cleanup failure')
                },
            }
        },
    })

    assert.throws(() => recorder.begin('custom'), /invalid animation interaction handle/)
    assert.equal(recorder.snapshot().status, 'dispose-failed')
    assert.equal(recorder.snapshot().activeInteractionCount, 1)

    recorder.dispose()
    assert.equal(cancelAttempts, 2)
    assert.equal(recorder.snapshot().status, 'disposed')
    assert.equal(recorder.snapshot().activeInteractionCount, 0)
})

test('seals and retries cleanup debt from a non-reentrant malformed handle', () => {
    let cancelAttempts = 0
    const recorder = createMotionSemanticCheckpointRecorder({
        beginInteraction() {
            return {
                cancel() {
                    cancelAttempts += 1
                    if (cancelAttempts === 1) throw new Error('temporary malformed cleanup failure')
                },
            }
        },
    })

    assert.throws(() => recorder.begin('custom'), /invalid animation interaction handle/)
    assert.equal(cancelAttempts, 1)
    assert.equal(recorder.snapshot().status, 'dispose-failed')
    assert.equal(recorder.snapshot().activeInteractionCount, 1)
    assert.throws(() => recorder.begin('custom'), /disposal started/)

    recorder.dispose()
    assert.equal(cancelAttempts, 2)
    assert.equal(recorder.snapshot().status, 'disposed')
    assert.equal(recorder.snapshot().activeInteractionCount, 0)
})
