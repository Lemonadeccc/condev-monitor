import assert from 'node:assert/strict'
import test from 'node:test'

import { createR3fPostprocessingPassRecorder } from '../build/esm/index.mjs'

function createClock(values) {
    let index = 0
    return () => {
        const value = values[index]
        index += 1
        if (value === undefined) throw new Error('clock exhausted')
        return value
    }
}

const createRecorder = options =>
    createR3fPostprocessingPassRecorder({
        passCoverage: 'caller-attests-complete-postprocessing-pass-boundaries',
        ...options,
    })

test('keeps CPU callback duration separate from caller-associated GPU timestamp evidence', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 3, 3, 4, 5]) })
    const renderPass = {}
    const outputPass = {}

    assert.equal(recorder.beginFrame(), true)
    const renderTicket = recorder.beginPass(renderPass, 'render')
    assert.ok(renderTicket)
    assert.equal(recorder.endPass(renderTicket, 'will-report-existing-timestamp-result'), true)
    const outputTicket = recorder.beginPass(outputPass, 'output')
    assert.ok(outputTicket)
    assert.equal(recorder.endPass(outputTicket), true)
    assert.equal(recorder.endFrame(), true)

    assert.equal(
        recorder.recordGpuEvidence(renderTicket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', {
            status: 'measured',
            timeMs: 0.5,
            source: 'webgl-timer-query',
        }),
        true
    )
    assert.deepEqual(recorder.inspectWindow({ startedAt: 0, endedAt: 5 }), {
        status: 'observed',
        window: { startedAt: 0, endedAt: 5 },
        retainedFrameCount: 1,
        passExecutionCount: 2,
        truncated: false,
        passes: [
            {
                anonymousId: 'r3f-pass-1',
                kind: 'render',
                sampleCount: 1,
                cpuCallbackMsP95: 2,
                gpu: { status: 'measured', timeMsP95: 0.5, source: 'webgl-timer-query' },
            },
            {
                anonymousId: 'r3f-pass-2',
                kind: 'output',
                sampleCount: 1,
                cpuCallbackMsP95: 1,
                gpu: { status: 'not-reported' },
            },
        ],
    })
    recorder.dispose()
})

test('stable host identity aggregates frames while pending and rejected GPU states remain explicit', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 2, 3, 10, 11, 14, 15]) })
    const effect = {}

    assert.equal(recorder.beginFrame(), true)
    const first = recorder.beginPass(effect, 'effect')
    assert.ok(first)
    assert.equal(recorder.endPass(first, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.endFrame(), true)
    assert.equal(
        recorder.recordGpuEvidence(first, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', {
            status: 'disjoint',
            source: 'webgl-timer-query',
        }),
        true
    )

    assert.equal(recorder.beginFrame(), true)
    const second = recorder.beginPass(effect, 'effect')
    assert.ok(second)
    assert.equal(recorder.endPass(second, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.endFrame(), true)

    const pass = recorder.getSnapshot().passes[0]
    assert.equal(pass.anonymousId, 'r3f-pass-1')
    assert.equal(pass.sampleCount, 2)
    assert.equal(pass.cpuCallbackMsP95, 3)
    assert.deepEqual(pass.gpu, { status: 'pending' })
    recorder.dispose()
})

test('malformed GPU evidence and wrong attestations never become measured', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 2, 3]) })
    assert.equal(recorder.beginFrame(), true)
    const ticket = recorder.beginPass({}, 'copy')
    assert.ok(ticket)
    assert.equal(recorder.endPass(ticket, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.endFrame(), true)

    assert.equal(
        recorder.recordGpuEvidence(ticket, 'wrong-attestation', { status: 'measured', timeMs: 1, source: 'webgpu-timestamp-query' }),
        false
    )
    const hostileEvidence = new Proxy(
        {},
        {
            get() {
                throw new Error('unreadable evidence')
            },
        }
    )
    assert.equal(
        recorder.recordGpuEvidence(ticket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', hostileEvidence),
        false
    )
    assert.deepEqual(recorder.getSnapshot().passes[0].gpu, { status: 'rejected' })
    assert.equal(recorder.getSnapshot().rejectedGpuEvidenceCount, 1)
    recorder.dispose()
})

test('GPU evidence getter re-entry fails closed without a stale measured overwrite', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 2, 3]) })
    assert.equal(recorder.beginFrame(), true)
    const ticket = recorder.beginPass({}, 'effect')
    assert.ok(ticket)
    assert.equal(recorder.endPass(ticket, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.endFrame(), true)

    let nestedResult = true
    const evidence = {
        get status() {
            nestedResult = recorder.recordGpuEvidence(ticket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', {
                status: 'measured',
                timeMs: 0.25,
                source: 'webgpu-timestamp-query',
            })
            return 'measured'
        },
        get source() {
            return 'webgpu-timestamp-query'
        },
        get timeMs() {
            return 0.5
        },
    }

    assert.equal(
        recorder.recordGpuEvidence(ticket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', evidence),
        false
    )
    assert.equal(nestedResult, false)
    assert.deepEqual(recorder.getSnapshot().passes[0].gpu, { status: 'rejected' })
    assert.equal(recorder.getSnapshot().pendingGpuSampleCount, 0)
    assert.equal(recorder.getSnapshot().rejectedGpuEvidenceCount, 1)
    recorder.dispose()
})

test('GPU evidence getter disposal invalidates the outer operation', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 2, 3]) })
    assert.equal(recorder.beginFrame(), true)
    const ticket = recorder.beginPass({}, 'effect')
    assert.ok(ticket)
    assert.equal(recorder.endPass(ticket, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.endFrame(), true)

    const evidence = {
        get status() {
            recorder.dispose()
            return 'measured'
        },
        get source() {
            return 'webgl-timer-query'
        },
        get timeMs() {
            return 0.5
        },
    }

    assert.equal(
        recorder.recordGpuEvidence(ticket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', evidence),
        false
    )
    assert.equal(recorder.getSnapshot().capability, 'disposed')
    assert.equal(recorder.getSnapshot().pendingGpuSampleCount, 0)
})

test('bounded frame history reports truncation and rejects windows intersecting eviction', () => {
    const recorder = createRecorder({ maxRetainedFrames: 1, now: createClock([0, 1, 2, 3, 10, 11, 12, 13]) })
    const pass = {}
    for (let frame = 0; frame < 2; frame += 1) {
        assert.equal(recorder.beginFrame(), true)
        const ticket = recorder.beginPass(pass, 'render')
        assert.ok(ticket)
        assert.equal(recorder.endPass(ticket), true)
        assert.equal(recorder.endFrame(), true)
    }

    assert.equal(recorder.getSnapshot().truncated, true)
    assert.equal(recorder.getSnapshot().droppedFrameCount, 1)
    assert.equal(recorder.inspectWindow({ startedAt: 0, endedAt: 13 }).status, 'unavailable')
    assert.equal(recorder.inspectWindow({ startedAt: 10, endedAt: 13 }).status, 'observed')
    recorder.dispose()
})

test('pass, identity, and pending GPU bounds fail closed without partial frame claims', () => {
    const passBound = createRecorder({ maxPassesPerFrame: 1, now: createClock([0, 1, 2, 3, 4, 5]) })
    assert.equal(passBound.beginFrame(), true)
    const first = passBound.beginPass({}, 'effect')
    assert.ok(first)
    assert.equal(passBound.endPass(first), true)
    const second = passBound.beginPass({}, 'output')
    assert.ok(second)
    assert.equal(passBound.endPass(second), false)
    assert.equal(passBound.endFrame(), false)
    assert.equal(passBound.getSnapshot().status, 'unavailable')
    passBound.dispose()

    const identityBound = createRecorder({ maxPassIdentities: 1, now: createClock([0, 1, 2, 3, 10]) })
    assert.equal(identityBound.beginFrame(), true)
    const identityFirst = identityBound.beginPass({}, 'effect')
    assert.ok(identityFirst)
    assert.equal(identityBound.endPass(identityFirst), true)
    assert.equal(identityBound.beginPass({}, 'output'), null)
    assert.equal(identityBound.getSnapshot().capability, 'incomplete')
    identityBound.dispose()

    const gpuBound = createRecorder({ maxPendingGpuSamples: 1, now: createClock([0, 1, 2, 3, 4, 5]) })
    assert.equal(gpuBound.beginFrame(), true)
    const gpuFirst = gpuBound.beginPass({}, 'effect')
    assert.ok(gpuFirst)
    assert.equal(gpuBound.endPass(gpuFirst, 'will-report-existing-timestamp-result'), true)
    const gpuSecond = gpuBound.beginPass({}, 'output')
    assert.ok(gpuSecond)
    assert.equal(gpuBound.endPass(gpuSecond, 'will-report-existing-timestamp-result'), true)
    assert.equal(gpuBound.endFrame(), true)
    assert.equal(gpuBound.getSnapshot().pendingGpuSampleCount, 1)
    assert.equal(gpuBound.getSnapshot().rejectedGpuEvidenceCount, 1)
    gpuBound.dispose()
})

test('invalid frame completion removes GPU samples that can no longer be reported', () => {
    const recorder = createRecorder({ now: createClock([0, 1, 2, Number.NaN]) })

    assert.equal(recorder.beginFrame(), true)
    const ticket = recorder.beginPass({}, 'effect')
    assert.ok(ticket)
    assert.equal(recorder.endPass(ticket, 'will-report-existing-timestamp-result'), true)
    assert.equal(recorder.getSnapshot().pendingGpuSampleCount, 1)

    assert.equal(recorder.endFrame(), false)
    assert.equal(recorder.getSnapshot().pendingGpuSampleCount, 0)
    assert.equal(
        recorder.recordGpuEvidence(ticket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', {
            status: 'measured',
            timeMs: 1,
            source: 'webgpu-timestamp-query',
        }),
        false
    )
    recorder.dispose()
})

test('clock re-entry, hostile pass identity, invalid kinds, cancellation, and disposal are isolated', () => {
    let recorder
    let reenter = true
    const now = () => {
        if (reenter) recorder.beginFrame()
        return 1
    }
    recorder = createRecorder({ now })
    assert.equal(recorder.beginFrame(), false)

    reenter = false
    assert.equal(recorder.beginFrame(), true)
    const hostilePass = new Proxy(
        {},
        {
            get() {
                assert.fail('recorder must not inspect pass properties')
            },
        }
    )
    assert.ok(recorder.beginPass(hostilePass, 'mask'))
    assert.equal(recorder.cancelFrame(), true)
    assert.equal(recorder.beginFrame(), true)
    assert.equal(recorder.beginPass({}, 'unknown-kind'), null)
    recorder.dispose()
    recorder.dispose()
    assert.equal(recorder.beginFrame(), false)
    assert.equal(recorder.getSnapshot().capability, 'disposed')
})

test('requires explicit coverage and bounded options', () => {
    assert.throws(() => createR3fPostprocessingPassRecorder({}), /passCoverage/)
    assert.throws(() => createRecorder({ now: null }), /now/)
    assert.throws(() => createRecorder({ maxRetainedFrames: 0 }), /maxRetainedFrames/)
    assert.throws(() => createRecorder({ maxPassesPerFrame: 1025 }), /maxPassesPerFrame/)
})
