import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserVideoPresentationRecorder, projectBrowserVideoPresentationSnapshot } from '../build/esm/index.mjs'

test('browser video presentation evidence is bounded, callback-scoped, and explicit about its proof boundary', () => {
    const recorder = createBrowserVideoPresentationRecorder({ now: () => 90, maxRecords: 2 })
    assert.equal(recorder.start(), true)
    assert.equal(recorder.observe(100, { mediaTime: 0, presentedFrames: 1, expectedDisplayTime: 104, processingDuration: 0.002 }), true)
    assert.equal(recorder.observe(116, { mediaTime: 0.016, presentedFrames: 2, expectedDisplayTime: 120, processingDuration: 0.003 }), true)
    assert.equal(recorder.observe(133, { mediaTime: 0.033, presentedFrames: 3, expectedDisplayTime: 132, processingDuration: 0.004 }), true)

    const snapshot = recorder.snapshot({ startedAt: 0, endedAt: 140 })
    assert.equal(snapshot.evidenceKind, 'browser-video-presentation-callback')
    assert.equal(snapshot.proves, 'browser-callback-and-metadata')
    assert.equal(snapshot.startToFirstCallbackMs, 10)
    assert.equal(snapshot.retainedRecordCount, 2)
    assert.equal(snapshot.droppedRecordCount, 1)
    assert.deepEqual(snapshot.records[0], {
        callbackAt: 116,
        callbackIntervalMs: 16,
        mediaTimeDeltaMs: 16,
        presentedFramesDelta: 1,
        expectedDisplayDeltaMs: 4,
        processingDurationMs: 3,
    })
    assert.equal('gpuUploadMs' in snapshot, false)
    assert.equal('firstPixelMs' in snapshot, false)
    assert.equal('src' in snapshot, false)
})

test('browser video presentation evidence rejects hostile metadata, resets lifecycle baselines, and seals on dispose', () => {
    const recorder = createBrowserVideoPresentationRecorder({ now: () => 10 })
    recorder.start()
    const hostile = {}
    Object.defineProperty(hostile, 'mediaTime', {
        get() {
            throw new Error('hostile metadata')
        },
    })
    assert.doesNotThrow(() => recorder.observe(20, hostile))
    assert.equal(recorder.observe(20, hostile), false)
    assert.equal(recorder.snapshot().rejectedRecordCount, 2)

    recorder.observe(30, { presentedFrames: 1 })
    recorder.resetBaseline()
    recorder.observe(50, { presentedFrames: 2 })
    assert.equal(recorder.snapshot().records.at(-1).callbackIntervalMs, null)
    recorder.stop()
    assert.equal(recorder.start(), true)
    recorder.observe(70, { presentedFrames: 3 })
    assert.equal(recorder.snapshot().startToFirstCallbackMs, 20)
    assert.equal(recorder.snapshot().records.at(-1).callbackIntervalMs, null)
    recorder.dispose()
    assert.equal(recorder.observe(60, { presentedFrames: 3 }), false)
    assert.equal(recorder.snapshot().state, 'disposed')
})

test('browser video presentation projections fail closed on hostile windows and clip records to the SDK-owned window', () => {
    const recorder = createBrowserVideoPresentationRecorder({ now: () => 0 })
    recorder.start()
    recorder.observe(10, { mediaTime: 0, presentedFrames: 1 })
    recorder.observe(20, { mediaTime: 0.01, presentedFrames: 2 })

    assert.deepEqual(recorder.snapshot({ startedAt: 20, endedAt: 10 }).records, [])
    const projected = projectBrowserVideoPresentationSnapshot(recorder.snapshot(), { startedAt: 15, endedAt: 25 })
    assert.ok(projected)
    assert.equal(projected.retainedRecordCount, 1)
    assert.equal(projected.records[0].callbackAt, 20)
    assert.equal(projected.truncated, true)
    assert.equal(projectBrowserVideoPresentationSnapshot(recorder.snapshot(), { startedAt: Number.NaN, endedAt: 25 }), null)

    const hostileRecord = { ...recorder.snapshot().records[0] }
    Object.defineProperty(hostileRecord, 'callbackAt', {
        get() {
            throw new Error('hostile callback timestamp')
        },
    })
    const hostile = { ...recorder.snapshot(), records: [hostileRecord] }
    assert.doesNotThrow(() => projectBrowserVideoPresentationSnapshot(hostile, { startedAt: 0, endedAt: 25 }))
    assert.equal(projectBrowserVideoPresentationSnapshot(hostile, { startedAt: 0, endedAt: 25 }), null)
})
