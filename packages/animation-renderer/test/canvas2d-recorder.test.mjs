import assert from 'node:assert/strict'
import test from 'node:test'

import { createRendererHostProbe } from '@condev-monitor/monitor-sdk-animation'

import { Canvas2dRecorderOptionsError, createCanvas2dRecorder } from '../build/esm/index.mjs'

function createSurface() {
    const listeners = new Map()
    return {
        width: 100,
        height: 50,
        addEventListener(type, listener) {
            const entries = listeners.get(type) ?? new Set()
            entries.add(listener)
            listeners.set(type, entries)
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener)
        },
        emit(type) {
            for (const listener of [...(listeners.get(type) ?? [])]) {
                if (typeof listener === 'function') listener({ type })
                else listener.handleEvent({ type })
            }
        },
        listenerCount() {
            return [...listeners.values()].reduce((total, entries) => total + entries.size, 0)
        },
    }
}

function createHarness(options = {}) {
    let time = 0
    const surface = options.surface ?? createSurface()
    const recorder = createCanvas2dRecorder({
        context: { canvas: surface },
        frameBoundary: 'complete-canvas-frame',
        drawCallCoverage: 'complete-frame',
        contextLossEventCoverage: 'complete-window',
        now: () => time,
        ...options,
        surface: undefined,
    })
    return {
        recorder,
        surface,
        get time() {
            return time
        },
        setTime(value) {
            time = value
        },
        advance(value) {
            time += value
        },
    }
}

function recordFrame(harness, { start, end, draws = {} }) {
    harness.setTime(start)
    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.recordOperations(draws), true)
    harness.setTime(end)
    assert.equal(harness.recorder.endFrame(), true)
}

test('requires explicit bounded host configuration', () => {
    const surface = createSurface()
    assert.throws(() => createCanvas2dRecorder({ context: null, frameBoundary: 'complete-canvas-frame' }), Canvas2dRecorderOptionsError)
    assert.throws(() => createCanvas2dRecorder({ context: { canvas: surface }, frameBoundary: 'partial-frame' }), /complete-canvas-frame/)
    assert.throws(
        () =>
            createCanvas2dRecorder({
                context: { canvas: surface },
                frameBoundary: 'complete-canvas-frame',
                drawCallCoverage: 'best-effort',
            }),
        /complete-frame/
    )
    assert.throws(
        () =>
            createCanvas2dRecorder({
                context: { canvas: surface },
                frameBoundary: 'complete-canvas-frame',
                contextLossEventCoverage: 'assumed',
            }),
        /complete-window/
    )
    for (const maxRetainedFrames of [0, 4_097, 1.5]) {
        assert.throws(
            () =>
                createCanvas2dRecorder({
                    context: { canvas: surface },
                    frameBoundary: 'complete-canvas-frame',
                    maxRetainedFrames,
                }),
            /maxRetainedFrames/
        )
    }
})

test('preserves measured zeroes without inventing Canvas2D GPU timing', () => {
    const harness = createHarness()
    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.recordOperations({ path: 0, text: 0, image: 0, pixelWrite: 0, clear: 0, other: 0 }), true)
    const readbackResult = {}
    assert.equal(
        harness.recorder.measureReadback({ pixels: 0, bytes: 0 }, () => readbackResult),
        readbackResult
    )
    assert.equal(
        harness.recorder.measureUpload({ pixels: 0, bytes: 0 }, () => 0),
        0
    )
    assert.equal(harness.recorder.endFrame(), true)

    const target = harness.recorder.inspect({
        evidenceWindow: { startedAt: 0, endedAt: 0, relation: 'selection-window' },
    })
    assert.deepEqual(target.inventory, { renderers: ['canvas2d'] })
    assert.deepEqual(target.renderer.metrics, {
        cpuFrameMsP95: 0,
        drawCallsP95: 0,
        uploadBytes: 0,
        readbackMsP95: 0,
        contextLossCount: 0,
    })
    assert.deepEqual(target.renderer.evidence, {
        window: { startedAt: 0, endedAt: 0 },
        acceptedSampleCount: 1,
        retainedSampleCount: 1,
        droppedSampleCount: 0,
        truncated: false,
    })
    assert.equal('gpuFrameMsP95' in target.renderer.metrics, false)
    assert.deepEqual(harness.recorder.takeRendererHostReading(), {
        gpuTimerCapability: 'unsupported',
        gpu: null,
        drawCalls: 0,
    })
    assert.equal(harness.recorder.takeRendererHostReading(), null)

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.aggregate.cpuFrameMsP95, 0)
    assert.equal(snapshot.aggregate.drawCommandsP95, 0)
    assert.equal(snapshot.aggregate.readbackMsP95, 0)
    assert.equal(snapshot.aggregate.uploadMsP95, 0)
    assert.equal(snapshot.aggregate.readbackPixels, 0)
    assert.equal(snapshot.aggregate.uploadBytes, 0)
    harness.recorder.dispose()
})

test('synchronous transfer wrappers preserve exact return and thrown values', () => {
    const harness = createHarness()
    const inactiveValue = { inactive: true }
    assert.equal(
        harness.recorder.measureReadback({}, () => inactiveValue),
        inactiveValue
    )

    assert.equal(harness.recorder.beginFrame(), true)
    const expected = new Error('business readback failure')
    assert.throws(
        () =>
            harness.recorder.measureReadback({ pixels: 10 }, () => {
                throw expected
            }),
        error => error === expected
    )
    const thenable = Promise.resolve('async upload')
    assert.equal(
        harness.recorder.measureUpload({ bytes: 10 }, () => thenable),
        thenable
    )
    harness.advance(5)
    assert.equal(harness.recorder.endFrame(), true)

    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.equal(inspected.metrics.cpuFrameMsP95, 5)
    assert.equal('readbackMsP95' in inspected.metrics, false)
    assert.equal('uploadBytes' in inspected.metrics, false)
    assert.equal(inspected.evidence.truncated, false)
    assert.equal(inspected.evidence.droppedSampleCount, 0)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 2)
    harness.recorder.dispose()
})

test('transfer wrappers return an opaque business result even when Promise classification throws', () => {
    const harness = createHarness()
    const opaqueResult = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error('opaque prototype')
            },
        }
    )

    assert.equal(harness.recorder.beginFrame(), true)
    let result
    assert.doesNotThrow(() => {
        result = harness.recorder.measureUpload({ bytes: 4 }, () => opaqueResult)
    })
    assert.equal(result, opaqueResult)
    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)

    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('uploadBytes' in inspected.metrics, false)
    assert.equal(inspected.evidence.truncated, false)
    assert.equal(inspected.evidence.droppedSampleCount, 0)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 1)
    harness.recorder.dispose()
})

test('transfer metadata cannot end a frame before business work and evidence classification finish', () => {
    const harness = createHarness()
    const businessResult = { exact: true }
    let metadataReads = 0
    let nestedEndResult
    let operationCalls = 0

    assert.equal(harness.recorder.beginFrame(), true)
    const result = harness.recorder.measureUpload(
        {
            get bytes() {
                metadataReads += 1
                nestedEndResult = harness.recorder.endFrame()
                return 4
            },
        },
        () => {
            operationCalls += 1
            return businessResult
        }
    )
    assert.equal(result, businessResult)
    assert.equal(metadataReads, 1)
    assert.equal(operationCalls, 1)
    assert.equal(nestedEndResult, false)
    assert.equal(harness.recorder.getSnapshot().active, true)

    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('uploadBytes' in inspected.metrics, false)
    assert.equal(harness.recorder.getSnapshot().measuredUploadCount, 0)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 1)
    harness.recorder.dispose()
})

test('Promise classification cannot re-enter endFrame or replace an opaque business result', () => {
    const harness = createHarness()
    let prototypeReads = 0
    let nestedEndResult
    const target = {}
    const opaqueResult = new Proxy(target, {
        getPrototypeOf() {
            prototypeReads += 1
            nestedEndResult = harness.recorder.endFrame()
            return Reflect.getPrototypeOf(target)
        },
    })

    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(
        harness.recorder.measureUpload({ bytes: 8 }, () => opaqueResult),
        opaqueResult
    )
    assert.equal(prototypeReads, 1)
    assert.equal(nestedEndResult, false)
    assert.equal(harness.recorder.getSnapshot().active, true)

    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('uploadBytes' in inspected.metrics, false)
    assert.equal(harness.recorder.getSnapshot().measuredUploadCount, 0)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 1)
    harness.recorder.dispose()
})

test('filters a bounded frame ring and marks only overlapping eviction as truncated', () => {
    const harness = createHarness({ maxRetainedFrames: 2 })
    recordFrame(harness, { start: 0, end: 10, draws: { path: 1 } })
    recordFrame(harness, { start: 20, end: 40, draws: { path: 3 } })
    recordFrame(harness, { start: 50, end: 80, draws: { path: 5 } })

    const full = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 100, relation: 'selection-window' })
    assert.equal(full.metrics.cpuFrameMsP95, 29.5)
    assert.equal(full.metrics.drawCallsP95, 4.9)
    assert.deepEqual(full.evidence.window, { startedAt: 20, endedAt: 80 })
    assert.equal(full.evidence.retainedSampleCount, 2)
    assert.equal(full.evidence.acceptedSampleCount, 3)
    assert.equal(full.evidence.droppedSampleCount, 1)
    assert.equal(full.evidence.acceptedSampleCount, full.evidence.retainedSampleCount + full.evidence.droppedSampleCount)
    assert.equal(full.evidence.truncated, true)

    const recent = harness.recorder.inspectWindow({ startedAt: 45, endedAt: 100, relation: 'interaction-window' })
    assert.equal(recent.metrics.cpuFrameMsP95, 30)
    assert.equal(recent.metrics.drawCallsP95, 5)
    assert.equal(recent.evidence.acceptedSampleCount, 1)
    assert.equal(recent.evidence.retainedSampleCount, 1)
    assert.equal(recent.evidence.droppedSampleCount, 0)
    assert.equal(recent.evidence.truncated, false)

    const ambiguous = harness.recorder.inspectWindow({ startedAt: 5, endedAt: 100, relation: 'selection-window' })
    assert.equal(ambiguous.capability.observed, false)
    assert.match(ambiguous.capability.reason, /exact sample count is unavailable/)
    assert.equal('evidence' in ambiguous, false)
    assert.equal(harness.recorder.getSnapshot().droppedFrameCount, 1)
    harness.recorder.dispose()
})

test('tracks boundary-visible backing changes and bounded context loss events', () => {
    const harness = createHarness()
    assert.equal(harness.surface.listenerCount(), 2)
    assert.equal(harness.recorder.beginFrame(), true)
    harness.surface.width = 200
    harness.setTime(4)
    harness.surface.emit('contextlost')
    harness.setTime(6)
    harness.surface.emit('contextrestored')
    harness.setTime(10)
    assert.equal(harness.recorder.endFrame(), true)

    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 10, relation: 'selection-window' })
    assert.equal(inspected.metrics.contextLossCount, 1)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.backingResizeCount, 1)
    assert.equal(snapshot.backingWidth, 200)
    assert.equal(snapshot.contextLossCount, 1)
    assert.equal(snapshot.contextRestoreCount, 1)

    harness.recorder.dispose()
    harness.recorder.dispose()
    assert.equal(harness.surface.listenerCount(), 0)
    assert.equal(harness.recorder.getSnapshot().retainedFrameCount, 0)
    assert.equal(harness.recorder.inspect().renderer.capability.state, 'unknown')
})

test('keeps incomplete draw coverage local and integrates complete readings with the host probe', () => {
    let time = 0
    const surface = createSurface()
    const partial = createCanvas2dRecorder({
        context: { canvas: surface },
        frameBoundary: 'complete-canvas-frame',
        now: () => time,
    })
    assert.equal(partial.beginFrame(), true)
    assert.equal(partial.recordDraw('image', 4), true)
    time = 8
    assert.equal(partial.endFrame(), true)
    const partialTarget = partial.inspectWindow({ startedAt: 0, endedAt: 8, relation: 'selection-window' })
    assert.equal(partialTarget.metrics.cpuFrameMsP95, 8)
    assert.equal('drawCallsP95' in partialTarget.metrics, false)
    assert.equal(partial.takeRendererHostReading(), null)
    partial.dispose()

    const harness = createHarness()
    recordFrame(harness, { start: 10, end: 20, draws: { image: 4 } })
    const emitted = []
    const probe = createRendererHostProbe({
        backend: 'canvas2d',
        read: harness.recorder.takeRendererHostReading,
        sink: { recordRenderStats: sample => emitted.push(sample) },
        now: () => 20,
    })
    const sample = probe.capture()
    assert.equal(sample.drawCalls, 4)
    assert.equal(sample.gpu.status, 'not-provided')
    assert.deepEqual(emitted, [sample])
    assert.equal(probe.capture(), null)
    probe.dispose()
    harness.recorder.dispose()
})

test('rejects nested, cancelled, invalid-clock, and invalid-operation samples without blocking business work', () => {
    const harness = createHarness()
    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.beginFrame(), false)
    assert.equal(harness.recorder.recordDraw('path', -1), false)
    assert.equal(harness.recorder.cancelFrame(), true)
    assert.equal(harness.recorder.endFrame(), false)

    harness.setTime(10)
    assert.equal(harness.recorder.beginFrame(), true)
    harness.setTime(5)
    assert.equal(harness.recorder.endFrame(), false)

    harness.setTime(Number.NaN)
    assert.equal(harness.recorder.beginFrame(), false)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.cancelledFrameCount, 1)
    assert.equal(snapshot.rejectedFrameCount, 2)
    assert.equal(snapshot.rejectedOperationCount, 1)
    assert.equal(snapshot.clockErrorCount, 1)
    assert.equal(snapshot.acceptedFrameCount, 0)
    harness.recorder.dispose()
})

test('invalid and unknown draw inputs poison complete coverage instead of becoming zero', () => {
    for (const record of [
        recorder => recorder.recordDraw('future-command', 1),
        recorder => recorder.recordOperations({ path: 1, typo: 1 }),
        recorder => recorder.recordOperations({ path: 1_000_000_000, text: 1 }),
        recorder => recorder.recordOperations({}),
    ]) {
        const harness = createHarness()
        assert.equal(harness.recorder.beginFrame(), true)
        assert.equal(record(harness.recorder), false)
        harness.advance(1)
        assert.equal(harness.recorder.endFrame(), true)
        const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
        assert.equal('drawCallsP95' in inspected.metrics, false)
        assert.equal(inspected.evidence.truncated, false)
        assert.equal(inspected.evidence.droppedSampleCount, 0)
        assert.equal(harness.recorder.getSnapshot().aggregate.drawCommandsP95, null)
        assert.equal(harness.recorder.takeRendererHostReading(), null)
        harness.recorder.dispose()
    }
})

test('recordDraw rejects runtime non-string kinds without invoking property-key coercion', () => {
    const harness = createHarness()
    let coercions = 0
    const hostileKind = {
        [Symbol.toPrimitive]() {
            coercions += 1
            harness.recorder.endFrame()
            return 'path'
        },
    }

    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.recordDraw(hostileKind, 1), false)
    assert.equal(coercions, 0)
    assert.equal(harness.recorder.getSnapshot().active, true)
    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('drawCallsP95' in inspected.metrics, false)
    assert.equal(harness.recorder.takeRendererHostReading(), null)
    harness.recorder.dispose()
})

test('unreadable transfer metadata still executes business work exactly once', () => {
    const harness = createHarness()
    assert.equal(harness.recorder.beginFrame(), true)
    let calls = 0
    const unreadable = new Proxy(
        {},
        {
            get() {
                throw new Error('revoked metadata')
            },
        }
    )
    const result = harness.recorder.measureReadback(unreadable, () => {
        calls += 1
        return 'business-result'
    })
    assert.equal(result, 'business-result')
    assert.equal(calls, 1)
    const unreadableOperations = new Proxy(
        {},
        {
            ownKeys() {
                throw new Error('revoked operations')
            },
        }
    )
    assert.equal(harness.recorder.recordOperations(unreadableOperations), false)
    harness.advance(2)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 2, relation: 'selection-window' })
    assert.equal('readbackMsP95' in inspected.metrics, false)
    assert.equal('drawCallsP95' in inspected.metrics, false)
    assert.equal(inspected.evidence.truncated, false)
    assert.equal(inspected.evidence.droppedSampleCount, 0)

    const unreadableWindow = new Proxy(
        {},
        {
            get() {
                throw new Error('revoked window')
            },
        }
    )
    assert.match(harness.recorder.inspectWindow(unreadableWindow).capability.reason, /unreadable/)
    harness.recorder.dispose()
})

test('recordOperations getters that cancel or dispose fail closed without throwing', () => {
    const cancelled = createHarness()
    assert.equal(cancelled.recorder.beginFrame(), true)
    let cancelResult
    let cancelGetterCalls = 0
    assert.doesNotThrow(() => {
        cancelResult = cancelled.recorder.recordOperations({
            get path() {
                cancelGetterCalls += 1
                cancelled.recorder.cancelFrame()
                return 1
            },
        })
    })
    assert.equal(cancelResult, false)
    assert.equal(cancelGetterCalls, 1)
    assert.equal(cancelled.recorder.getSnapshot().active, false)
    assert.equal(cancelled.recorder.getSnapshot().cancelledFrameCount, 1)
    assert.equal(cancelled.recorder.getSnapshot().rejectedOperationCount, 1)
    cancelled.recorder.dispose()

    const disposed = createHarness()
    assert.equal(disposed.recorder.beginFrame(), true)
    let disposeResult
    let disposeGetterCalls = 0
    assert.doesNotThrow(() => {
        disposeResult = disposed.recorder.recordOperations({
            get path() {
                disposeGetterCalls += 1
                disposed.recorder.dispose()
                return 1
            },
        })
    })
    assert.equal(disposeResult, false)
    assert.equal(disposeGetterCalls, 1)
    assert.equal(disposed.recorder.getSnapshot().capability, 'disposed')
    assert.equal(disposed.recorder.getSnapshot().rejectedOperationCount, 1)
})

test('recordOperations getters cannot end and seal a trusted draw frame', () => {
    const harness = createHarness()
    let getterCalls = 0
    let nestedEndResult

    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(
        harness.recorder.recordOperations({
            get path() {
                getterCalls += 1
                nestedEndResult = harness.recorder.endFrame()
                return 1
            },
        }),
        false
    )
    assert.equal(getterCalls, 1)
    assert.equal(nestedEndResult, false)
    assert.equal(harness.recorder.getSnapshot().active, true)

    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('drawCallsP95' in inspected.metrics, false)
    assert.equal(harness.recorder.takeRendererHostReading(), null)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 1)
    harness.recorder.dispose()
})

test('nested recordOperations invalidates the outer draw evidence without sealing the frame', () => {
    const harness = createHarness()
    let nestedResult

    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(
        harness.recorder.recordOperations({
            get path() {
                nestedResult = harness.recorder.recordOperations({ text: 2 })
                return 1
            },
        }),
        false
    )
    assert.equal(nestedResult, false)
    assert.equal(harness.recorder.getSnapshot().active, true)

    harness.advance(1)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal('drawCallsP95' in inspected.metrics, false)
    assert.equal(harness.recorder.takeRendererHostReading(), null)
    assert.equal(harness.recorder.getSnapshot().rejectedOperationCount, 1)
    harness.recorder.dispose()
})

test('a newer invalid frame cannot leak an older buffered host reading', () => {
    const harness = createHarness()
    recordFrame(harness, { start: 0, end: 5, draws: { image: 4 } })
    assert.equal(harness.recorder.getSnapshot().hostReadingBuffered, true)

    harness.setTime(10)
    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.recordOperations({ image: 1, unknown: 1 }), false)
    harness.setTime(15)
    assert.equal(harness.recorder.endFrame(), true)
    assert.equal(harness.recorder.takeRendererHostReading(), null)
    assert.equal(harness.recorder.getSnapshot().droppedHostReadingCount, 1)
    harness.recorder.dispose()
})

test('reports evicted-only windows distinctly and rejects cross-frame clock regression', () => {
    const harness = createHarness({ maxRetainedFrames: 1 })
    recordFrame(harness, { start: 0, end: 10, draws: { path: 1 } })
    recordFrame(harness, { start: 20, end: 30, draws: { path: 2 } })
    const evicted = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 10, relation: 'interaction-window' })
    assert.equal(evicted.capability.observed, false)
    assert.match(evicted.capability.reason, /evicted/)

    harness.setTime(15)
    assert.equal(harness.recorder.beginFrame(), true)
    assert.equal(harness.recorder.recordDraw('path'), true)
    harness.setTime(18)
    assert.equal(harness.recorder.endFrame(), false)
    assert.equal(harness.recorder.getSnapshot().rejectedFrameCount, 1)
    harness.recorder.dispose()
})

test('nested transfer measurement and endFrame re-entry fail closed', () => {
    const harness = createHarness()
    assert.equal(harness.recorder.beginFrame(), true)
    let innerCalls = 0
    const value = harness.recorder.measureReadback({}, () =>
        harness.recorder.measureReadback({}, () => {
            innerCalls += 1
            return 7
        })
    )
    assert.equal(value, 7)
    assert.equal(innerCalls, 1)
    assert.equal(
        harness.recorder.measureUpload({}, () => {
            assert.equal(harness.recorder.endFrame(), false)
            return 'upload'
        }),
        'upload'
    )
    harness.advance(5)
    assert.equal(harness.recorder.endFrame(), true)
    const inspected = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.equal('readbackMsP95' in inspected.metrics, false)
    assert.equal('uploadBytes' in inspected.metrics, false)
    assert.equal(inspected.evidence.truncated, false)
    assert.equal(inspected.evidence.droppedSampleCount, 0)
    assert.equal(harness.recorder.getSnapshot().measuredReadbackCount, 0)
    assert.equal(harness.recorder.getSnapshot().measuredUploadCount, 0)
    harness.recorder.dispose()
})

test('context-loss zero requires explicit coverage or an observed event', () => {
    let time = 0
    const surface = createSurface()
    const recorder = createCanvas2dRecorder({
        context: { canvas: surface },
        frameBoundary: 'complete-canvas-frame',
        now: () => time,
    })
    assert.equal(recorder.beginFrame(), true)
    time = 5
    assert.equal(recorder.endFrame(), true)
    let inspected = recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.equal('contextLossCount' in inspected.metrics, false)
    assert.equal(recorder.getSnapshot().contextLossEventCapability, false)

    time = 6
    surface.emit('contextlost')
    inspected = recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.equal(inspected.metrics.contextLossCount, 0)
    assert.equal(recorder.getSnapshot().contextLossEventCapability, true)
    recorder.dispose()

    const withoutListeners = createCanvas2dRecorder({
        context: { canvas: { width: 10, height: 10 } },
        frameBoundary: 'complete-canvas-frame',
        contextLossEventCoverage: 'complete-window',
        now: () => time,
    })
    assert.equal(withoutListeners.beginFrame(), true)
    time = 10
    assert.equal(withoutListeners.endFrame(), true)
    inspected = withoutListeners.inspectWindow({ startedAt: 6, endedAt: 10, relation: 'selection-window' })
    assert.equal('contextLossCount' in inspected.metrics, false)
    withoutListeners.dispose()
})

test('retries cleanup after partial context-listener installation', () => {
    const listeners = new Map()
    let failedCleanup = false
    const surface = {
        width: 10,
        height: 10,
        addEventListener(type, listener) {
            if (type === 'contextrestored') throw new Error('restore listener unavailable')
            listeners.set(type, listener)
        },
        removeEventListener(type, listener) {
            if (!failedCleanup) {
                failedCleanup = true
                throw new Error('transient cleanup failure')
            }
            if (listeners.get(type) === listener) listeners.delete(type)
        },
    }

    const recorder = createCanvas2dRecorder({
        context: { canvas: surface },
        frameBoundary: 'complete-canvas-frame',
    })

    assert.equal(listeners.size, 1)
    assert.equal(recorder.getSnapshot().contextErrorCount, 2)
    recorder.dispose()
    assert.equal(listeners.size, 0)
})
