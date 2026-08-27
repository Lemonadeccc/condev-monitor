import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { WebGpuTransferRecorderOptionsError, createWebGpuTransferRecorder } from '../build/esm/index.mjs'

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

async function flushPromises() {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

function createHarness(options = {}) {
    let time = 0
    const lost = deferred()
    const device = options.device ?? { lost: lost.promise }
    const recorder = createWebGpuTransferRecorder({
        device,
        now: () => time,
        ...options,
        device,
    })
    return {
        recorder,
        device,
        lost,
        setTime(value) {
            time = value
        },
        advance(value) {
            time += value
        },
    }
}

function upload(harness, { start, end, bytes = 4, includeBytes = true, kind = 'queue-write-buffer', result = undefined }) {
    harness.setTime(start)
    let calls = 0
    const returned = harness.recorder.measureUpload({ kind, ...(includeBytes ? { bytes } : {}) }, () => {
        calls += 1
        harness.setTime(end)
        return result
    })
    assert.equal(calls, 1)
    assert.equal(returned, result)
}

test('requires a bounded Promise-like device configuration', () => {
    for (const options of [undefined, {}, { device: null }, { device: {} }, { device: { lost: null } }]) {
        assert.throws(() => createWebGpuTransferRecorder(options), WebGpuTransferRecorderOptionsError)
    }
    for (const maxRetainedOperations of [0, 4_097, 1.5]) {
        assert.throws(
            () => createWebGpuTransferRecorder({ device: { lost: new Promise(() => {}) }, maxRetainedOperations }),
            /maxRetainedOperations/u
        )
    }
    for (const maxPendingReadbacks of [0, 9, 1.5]) {
        assert.throws(
            () => createWebGpuTransferRecorder({ device: { lost: new Promise(() => {}) }, maxPendingReadbacks }),
            /maxPendingReadbacks/u
        )
    }
    assert.throws(
        () =>
            createWebGpuTransferRecorder(
                Object.defineProperty({}, 'device', {
                    get() {
                        throw new Error('hostile options')
                    },
                })
            ),
        error => error instanceof WebGpuTransferRecorderOptionsError && /hostile options/u.test(error.message)
    )
})

test('records synchronous void upload scheduling without changing the business result', () => {
    const harness = createHarness()
    upload(harness, { start: 0, end: 2, bytes: 0 })

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.acceptedUploadCount, 1)
    assert.equal(snapshot.aggregate.uploadCallMsP95, 2)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, 0)
    assert.equal(snapshot.aggregate.retainedMeasuredUploadKinds['queue-write-buffer'], 1)

    const target = harness.recorder.inspect({
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 0, endedAt: 2, relation: 'selection-window' },
    })
    assert.deepEqual(target.inventory, { renderers: ['webgpu'] })
    assert.deepEqual(target.renderer.metrics, { uploadBytes: 0 })
    assert.deepEqual(target.renderer.evidence, {
        window: { startedAt: 0, endedAt: 2 },
        acceptedSampleCount: 1,
        retainedSampleCount: 1,
        droppedSampleCount: 0,
        rejectedSampleCount: 0,
        truncated: false,
    })
    harness.recorder.dispose()
})

test('keeps transfer target evidence local without inspecting a RUM window', () => {
    const harness = createHarness()
    upload(harness, { start: 0, end: 2, bytes: 8 })
    const before = harness.recorder.getSnapshot()
    let evidenceWindowReads = 0
    const unavailableWindow = inspectionPurpose =>
        Object.defineProperty(inspectionPurpose === undefined ? {} : { inspectionPurpose }, 'evidenceWindow', {
            get() {
                evidenceWindowReads += 1
                throw new Error('RUM must not inspect local transfer evidence')
            },
        })

    assert.equal(harness.recorder.inspect(unavailableWindow('rum')), null)
    assert.equal(harness.recorder.inspect(unavailableWindow()), null)
    assert.equal(harness.recorder.inspect(unavailableWindow('invalid-purpose')), null)
    assert.equal(
        harness.recorder.inspect(
            Object.defineProperty({}, 'inspectionPurpose', {
                get() {
                    throw new Error('unreadable purpose')
                },
            })
        ),
        null
    )
    assert.equal(evidenceWindowReads, 0)
    assert.deepEqual(harness.recorder.getSnapshot(), before)

    const local = harness.recorder.inspect({
        inspectionPurpose: 'local',
        evidenceWindow: { startedAt: 0, endedAt: 2, relation: 'selection-window' },
    })
    assert.deepEqual(local.renderer.metrics, { uploadBytes: 8 })
    harness.recorder.dispose()
})

test('unknown upload bytes stay unknown while all closed upload kinds remain local', () => {
    const harness = createHarness()
    const kinds = ['queue-write-buffer', 'queue-write-texture', 'queue-copy-external-image-to-texture', 'mapped-buffer-write-unmap']
    for (const [index, kind] of kinds.entries()) {
        upload(harness, { start: index * 2, end: index * 2 + 1, bytes: index, includeBytes: index !== 2, kind })
    }

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    assert.deepEqual(snapshot.aggregate.retainedMeasuredUploadKinds, {
        'queue-write-buffer': 1,
        'queue-write-texture': 1,
        'queue-copy-external-image-to-texture': 1,
        'mapped-buffer-write-unmap': 1,
    })
    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 7, relation: 'selection-window' })
    assert.equal('uploadBytes' in target.metrics, false)
    assert.equal(target.evidence.acceptedSampleCount, 4)
    harness.recorder.dispose()
})

test('upload failures, invalid metadata, and Promise misuse fail closed without wrapping errors', async () => {
    const harness = createHarness()
    const expected = new Error('business upload failure')
    harness.setTime(0)
    assert.throws(
        () =>
            harness.recorder.measureUpload({ kind: 'queue-write-texture', bytes: 4 }, () => {
                harness.setTime(1)
                throw expected
            }),
        error => error === expected
    )

    upload(harness, { start: 2, end: 3, bytes: -1 })
    const promise = Promise.resolve('async misuse')
    upload(harness, { start: 4, end: 5, bytes: 4, result: promise })
    assert.equal(await promise, 'async misuse')

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.acceptedUploadCount, 0)
    assert.equal(snapshot.rejectedUploadCount, 3)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.deepEqual(target.metrics, {})
    assert.equal(target.evidence.rejectedSampleCount, 3)
    harness.recorder.dispose()
})

test('non-void upload results and invalid readback attestations never become measured', async () => {
    const harness = createHarness()
    let thenReads = 0
    const opaque = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error('opaque prototype')
            },
        }
    )
    upload(harness, { start: 0, end: 1, bytes: 4, result: opaque })
    const customThenable = Object.defineProperty({}, 'then', {
        get() {
            thenReads += 1
            return () => undefined
        },
    })
    upload(harness, { start: 2, end: 3, bytes: 4, result: customThenable })
    assert.equal(thenReads, 0)
    const foreignPromise = runInNewContext("Promise.resolve('foreign')")
    upload(harness, { start: 4, end: 5, bytes: 4, result: foreignPromise })
    assert.equal(await foreignPromise, 'foreign')

    const mapping = deferred()
    harness.setTime(6)
    const returned = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'missing-attestation' },
        () => mapping.promise
    )
    assert.notEqual(returned, mapping.promise)
    harness.setTime(7)
    mapping.resolve(undefined)
    await returned

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.acceptedUploadCount, 0)
    assert.equal(snapshot.rejectedUploadCount, 3)
    assert.equal(snapshot.acceptedReadbackCount, 0)
    assert.equal(snapshot.rejectedReadbackCount, 1)
    harness.recorder.dispose()
})

test('observes map readiness through a transparent derived Promise', async () => {
    const harness = createHarness()
    const mapping = deferred()
    const value = { mapped: true }
    harness.setTime(10)
    const observed = harness.recorder.observeReadback(
        {
            kind: 'texture-to-buffer-map-read',
            bytes: 64,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => mapping.promise
    )
    assert.notEqual(observed, mapping.promise)
    assert.equal(harness.recorder.getSnapshot().pendingReadbackCount, 1)

    harness.setTime(14)
    mapping.resolve(value)
    assert.equal(await observed, value)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.pendingReadbackCount, 0)
    assert.equal(snapshot.acceptedReadbackCount, 1)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, 4)
    assert.equal(snapshot.aggregate.attestedReadbackBytes, 64)
    assert.equal(snapshot.aggregate.retainedMeasuredReadbackKinds['texture-to-buffer-map-read'], 1)

    const target = harness.recorder.inspectWindow({ startedAt: 10, endedAt: 14, relation: 'interaction-window' })
    assert.deepEqual(target.metrics, { readbackMsP95: 4 })
    harness.recorder.dispose()
})

test('preserves the original readback rejection object without inferring device loss', async () => {
    const harness = createHarness()
    const mapping = deferred()
    const expected = Object.assign(new Error('mapping aborted'), { name: 'AbortError' })
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 16, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => mapping.promise
    )
    harness.setTime(3)
    mapping.reject(expected)
    await assert.rejects(observed, error => error === expected)

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.capability, 'supported')
    assert.equal(snapshot.deviceLostCount, 0)
    assert.equal(snapshot.rejectedReadbackCount, 1)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    harness.recorder.dispose()
})

test('pending readback makes the shared target provider unavailable until settlement', async () => {
    const harness = createHarness()
    upload(harness, { start: 0, end: 1, bytes: 8 })
    const mapping = deferred()
    harness.setTime(2)
    const observed = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 32, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => mapping.promise
    )

    const pendingSnapshot = harness.recorder.getSnapshot()
    assert.equal(pendingSnapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    assert.equal(pendingSnapshot.aggregate.attestedReadbackBytes, null)
    const pending = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(pending.capability.observed, false)
    assert.match(pending.capability.reason, /pending in this window/u)

    harness.setTime(5)
    mapping.resolve(undefined)
    await observed
    const complete = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 5, relation: 'selection-window' })
    assert.deepEqual(complete.metrics, { uploadBytes: 8, readbackMsP95: 3 })
    assert.equal(complete.evidence.acceptedSampleCount, 2)
    harness.recorder.dispose()
})

test('snapshot readback aggregation waits for every observed candidate to settle', async () => {
    const harness = createHarness({ maxPendingReadbacks: 2 })
    const fast = deferred()
    harness.setTime(0)
    const fastObserved = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => fast.promise
    )
    harness.setTime(2)
    fast.resolve(undefined)
    await fastObserved
    assert.equal(harness.recorder.getSnapshot().aggregate.hostObservedReadbackReadyMsP95, 2)

    const slow = deferred()
    harness.setTime(3)
    const slowObserved = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => slow.promise
    )
    const pendingSnapshot = harness.recorder.getSnapshot()
    assert.equal(pendingSnapshot.pendingReadbackCount, 1)
    assert.equal(pendingSnapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    assert.equal(pendingSnapshot.aggregate.attestedReadbackBytes, null)
    const pendingTarget = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 4, relation: 'selection-window' })
    assert.equal(pendingTarget.capability.observed, false)
    assert.match(pendingTarget.capability.reason, /pending in this window/u)

    harness.setTime(5)
    slow.resolve(undefined)
    await slowObserved
    const complete = harness.recorder.getSnapshot()
    assert.equal(complete.aggregate.hostObservedReadbackReadyMsP95, 2)
    assert.equal(complete.aggregate.attestedReadbackBytes, 8)
    harness.recorder.dispose()
})

test('missing readback byte metadata does not hide a valid ready-latency sample', async () => {
    const harness = createHarness()
    const mapping = deferred()
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => mapping.promise
    )
    harness.setTime(2)
    mapping.resolve(undefined)
    await observed

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, 2)
    assert.equal(snapshot.aggregate.attestedReadbackBytes, null)
    assert.deepEqual(harness.recorder.inspectWindow({ startedAt: 0, endedAt: 2, relation: 'selection-window' }).metrics, {
        readbackMsP95: 2,
    })
    harness.recorder.dispose()
})

test('pending capacity never skips business work but makes readback aggregation fail closed', async () => {
    const harness = createHarness({ maxPendingReadbacks: 1 })
    const first = deferred()
    const second = deferred()
    let calls = 0
    harness.setTime(0)
    const firstObserved = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => {
            calls += 1
            return first.promise
        }
    )
    harness.setTime(1)
    const secondReturned = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => {
            calls += 1
            return second.promise
        }
    )
    assert.equal(calls, 2)
    assert.notEqual(secondReturned, second.promise)

    harness.setTime(2)
    first.resolve(undefined)
    second.resolve(undefined)
    await Promise.all([firstObserved, secondReturned])
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.acceptedReadbackCount, 1)
    assert.equal(snapshot.skippedReadbackCapacityCount, 1)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    assert.equal(snapshot.aggregate.retainedMeasuredReadbackKinds['buffer-map-read'], 1)
    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 2, relation: 'selection-window' })
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /Readback correlation is incomplete/u)
    harness.recorder.dispose()
})

test('only operations wholly contained in the target window are attributed', async () => {
    const harness = createHarness()
    upload(harness, { start: 0, end: 4, bytes: 10 })
    upload(harness, { start: 5, end: 6, bytes: 20 })

    const contained = harness.recorder.inspectWindow({ startedAt: 4.5, endedAt: 6.5, relation: 'selection-window' })
    assert.deepEqual(contained.metrics, { uploadBytes: 20 })
    assert.equal(contained.evidence.acceptedSampleCount, 1)
    const crossingOnly = harness.recorder.inspectWindow({ startedAt: 1, endedAt: 3, relation: 'selection-window' })
    assert.equal(crossingOnly.capability.observed, false)
    harness.recorder.dispose()
})

test('measured eviction remains exact and truncation follows dropped accepted samples', () => {
    const harness = createHarness({ maxRetainedOperations: 1 })
    upload(harness, { start: 0, end: 1, bytes: 4 })
    upload(harness, { start: 2, end: 3, bytes: 8 })

    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(target.evidence.acceptedSampleCount, 2)
    assert.equal(target.evidence.retainedSampleCount, 1)
    assert.equal(target.evidence.droppedSampleCount, 1)
    assert.equal(target.evidence.rejectedSampleCount, 0)
    assert.equal(target.evidence.truncated, true)
    assert.deepEqual(target.metrics, {})
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    harness.recorder.dispose()
})

test('rejected-only eviction keeps the RUM count invariant exact', () => {
    const harness = createHarness({ maxRetainedOperations: 1 })
    harness.setTime(0)
    harness.recorder.measureUpload({ kind: 'invalid-kind', bytes: 4 }, () => harness.setTime(1))
    upload(harness, { start: 2, end: 3, bytes: 8 })

    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.deepEqual(target.evidence, {
        window: { startedAt: 0, endedAt: 3 },
        acceptedSampleCount: 1,
        retainedSampleCount: 1,
        droppedSampleCount: 0,
        rejectedSampleCount: 1,
        truncated: false,
    })
    assert.equal(target.evidence.acceptedSampleCount, target.evidence.retainedSampleCount + target.evidence.droppedSampleCount)
    assert.equal(target.evidence.truncated, target.evidence.droppedSampleCount > 0)
    assert.deepEqual(target.metrics, {})
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    harness.recorder.dispose()
})

test('partially intersecting forgotten history is unavailable instead of guessed', () => {
    const harness = createHarness({ maxRetainedOperations: 1 })
    upload(harness, { start: 0, end: 1, bytes: 4 })
    upload(harness, { start: 2, end: 3, bytes: 8 })

    const target = harness.recorder.inspectWindow({ startedAt: 0.5, endedAt: 3, relation: 'selection-window' })
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /eviction intersects/u)
    harness.recorder.dispose()
})

test('out-of-order readback completion uses an eviction envelope rather than completion-order assumptions', async () => {
    const harness = createHarness({ maxRetainedOperations: 1, maxPendingReadbacks: 2 })
    const slow = deferred()
    const fast = deferred()
    harness.setTime(0)
    const slowObserved = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => slow.promise
    )
    harness.setTime(1)
    const fastObserved = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => fast.promise
    )
    harness.setTime(2)
    fast.resolve(undefined)
    await fastObserved
    harness.setTime(3)
    slow.resolve(undefined)
    await slowObserved

    const complete = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(complete.evidence.acceptedSampleCount, 2)
    assert.equal(complete.evidence.droppedSampleCount, 1)
    assert.equal(harness.recorder.getSnapshot().aggregate.hostObservedReadbackReadyMsP95, null)
    assert.equal(harness.recorder.getSnapshot().aggregate.attestedReadbackBytes, null)
    const partial = harness.recorder.inspectWindow({ startedAt: 1.5, endedAt: 3, relation: 'selection-window' })
    assert.equal(partial.capability.observed, false)
    harness.recorder.dispose()
})

test('device loss is terminal and late mapping fulfillment cannot become measured', async () => {
    const harness = createHarness()
    const mapping = deferred()
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => mapping.promise
    )
    harness.setTime(1)
    harness.lost.resolve({ reason: 'unknown' })
    await flushPromises()
    assert.equal(harness.recorder.getSnapshot().capability, 'device-lost')
    assert.equal(harness.recorder.getSnapshot().pendingReadbackCount, 0)

    harness.setTime(2)
    mapping.resolve('late')
    assert.equal(await observed, 'late')
    assert.equal(harness.recorder.getSnapshot().acceptedReadbackCount, 0)
    assert.equal(harness.recorder.inspectWindow({ startedAt: 0, endedAt: 2, relation: 'selection-window' }).capability.state, 'unknown')
    harness.recorder.dispose()
})

test('a lost-promise rejection is observer failure, not a measured transfer', async () => {
    const harness = createHarness()
    harness.lost.reject(new Error('lost observer failed'))
    await flushPromises()
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.capability, 'error')
    assert.equal(snapshot.observerErrorCount, 1)
    assert.equal(snapshot.deviceLostCount, 0)
    harness.recorder.dispose()
})

test('a failed device-lost subscription is cached for every recorder sharing the device', () => {
    const lost = new Promise(() => {})
    const expected = new Error('hostile lost constructor')
    Object.defineProperty(lost, 'constructor', {
        configurable: true,
        get() {
            throw expected
        },
    })
    const device = { lost }
    const first = createWebGpuTransferRecorder({ device })
    const second = createWebGpuTransferRecorder({ device })
    const firstSnapshot = first.getSnapshot()
    const secondSnapshot = second.getSnapshot()
    assert.equal(firstSnapshot.capability, 'error')
    assert.equal(secondSnapshot.capability, 'error')
    assert.equal(firstSnapshot.observerErrorCount, 1)
    assert.equal(secondSnapshot.observerErrorCount, 1)
    Reflect.deleteProperty(lost, 'constructor')
    first.dispose()
    second.dispose()
})

test('clock failures permanently invalidate only the affected transfer family aggregate', () => {
    let time = 0
    let clockThrows = true
    const lost = new Promise(() => {})
    const recorder = createWebGpuTransferRecorder({
        device: { lost },
        now() {
            if (clockThrows) throw new Error('clock failure')
            return time
        },
    })
    recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => undefined)
    clockThrows = false
    time = 1
    recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 8 }, () => {
        time = 2
    })
    time = 3
    const mapping = deferred()
    const observed = recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => mapping.promise
    )
    time = 4
    mapping.resolve(undefined)
    return observed.then(() => {
        const snapshot = recorder.getSnapshot()
        assert.equal(snapshot.uploadCorrelationInvalid, true)
        assert.equal(snapshot.readbackCorrelationInvalid, false)
        assert.equal(snapshot.acceptedUploadCount, 1)
        assert.equal(snapshot.aggregate.uploadCallMsP95, null)
        assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
        assert.equal(snapshot.aggregate.retainedMeasuredUploadKinds['queue-write-buffer'], 1)
        assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, 1)
        const target = recorder.inspectWindow({ startedAt: 3, endedAt: 4, relation: 'selection-window' })
        assert.equal(target.capability.observed, false)
        assert.match(target.capability.reason, /Upload correlation is incomplete/u)
        recorder.dispose()
    })
})

test('a readback settlement clock failure cannot be healed by a later valid readback', async () => {
    let time = 0
    let clockThrows = false
    const recorder = createWebGpuTransferRecorder({
        device: { lost: new Promise(() => {}) },
        now() {
            if (clockThrows) throw new Error('clock failure')
            return time
        },
    })
    const failedClockMapping = deferred()
    const failedClockObserved = recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => failedClockMapping.promise
    )
    clockThrows = true
    failedClockMapping.resolve('first')
    assert.equal(await failedClockObserved, 'first')

    clockThrows = false
    time = 2
    const validMapping = deferred()
    const validObserved = recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 8,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => validMapping.promise
    )
    time = 3
    validMapping.resolve('second')
    assert.equal(await validObserved, 'second')

    const snapshot = recorder.getSnapshot()
    assert.equal(snapshot.clockErrorCount, 1)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.acceptedReadbackCount, 1)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    assert.equal(snapshot.aggregate.attestedReadbackBytes, null)
    const target = recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /Readback correlation is incomplete/u)
    recorder.dispose()
})

test('nested operations execute every business callback but reject ambiguous evidence', () => {
    const harness = createHarness()
    let outerCalls = 0
    let nestedCalls = 0
    harness.setTime(0)
    harness.recorder.measureUpload(
        {
            kind: 'queue-write-buffer',
            get bytes() {
                harness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 1 }, () => {
                    nestedCalls += 1
                })
                return 4
            },
        },
        () => {
            outerCalls += 1
            harness.setTime(1)
        }
    )
    assert.equal(outerCalls, 1)
    assert.equal(nestedCalls, 1)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.reentrantOperationCount, 1)
    assert.equal(snapshot.uploadCorrelationInvalid, true)
    assert.equal(snapshot.acceptedUploadCount, 0)
    assert.equal(snapshot.rejectedUploadCount, 1)
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    harness.recorder.dispose()
})

test('upload-to-readback reentry executes business work and invalidates both families', async () => {
    const harness = createHarness()
    const nestedMapping = deferred()
    let nestedObserved
    let nestedCalls = 0
    harness.setTime(0)
    harness.recorder.measureUpload(
        {
            kind: 'queue-write-buffer',
            get bytes() {
                nestedObserved = harness.recorder.observeReadback(
                    { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
                    () => {
                        nestedCalls += 1
                        return nestedMapping.promise
                    }
                )
                assert.notEqual(nestedObserved, nestedMapping.promise)
                return 4
            },
        },
        () => harness.setTime(1)
    )
    nestedMapping.resolve('nested')
    assert.equal(await nestedObserved, 'nested')

    const validMapping = deferred()
    harness.setTime(2)
    const validObserved = harness.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 8, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => validMapping.promise
    )
    harness.setTime(3)
    validMapping.resolve('valid')
    assert.equal(await validObserved, 'valid')

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(nestedCalls, 1)
    assert.equal(snapshot.uploadCorrelationInvalid, true)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.acceptedReadbackCount, 1)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /correlation is incomplete/u)
    harness.recorder.dispose()
})

test('readback-to-upload reentry executes business work and invalidates both families', async () => {
    const harness = createHarness()
    const mapping = deferred()
    let nestedCalls = 0
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        {
            get kind() {
                harness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
                    nestedCalls += 1
                })
                return 'buffer-map-read'
            },
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => mapping.promise
    )
    mapping.resolve('outer')
    assert.equal(await observed, 'outer')

    upload(harness, { start: 1, end: 2, bytes: 8 })
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(nestedCalls, 1)
    assert.equal(snapshot.uploadCorrelationInvalid, true)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.acceptedUploadCount, 1)
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    const target = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 2, relation: 'selection-window' })
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /correlation is incomplete/u)
    harness.recorder.dispose()
})

test('dispose during a business callback is latched without changing its return value', () => {
    const harness = createHarness()
    const expected = { exact: true }
    harness.setTime(0)
    const result = harness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
        harness.recorder.dispose()
        harness.setTime(1)
        return expected
    })
    assert.equal(result, expected)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.capability, 'disposed')
    assert.equal(snapshot.retainedUploadCount, 0)
})

test('hostile inspection getters cannot publish a mixed snapshot', () => {
    const harness = createHarness()
    let businessCalls = 0
    const target = harness.recorder.inspectWindow({
        get startedAt() {
            harness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
                businessCalls += 1
            })
            return 0
        },
        endedAt: 1,
        relation: 'selection-window',
    })
    assert.equal(businessCalls, 1)
    assert.equal(target.capability.observed, false)
    assert.match(target.capability.reason, /changed during window inspection/u)
    assert.equal(harness.recorder.getSnapshot().acceptedUploadCount, 0)
    upload(harness, { start: 0, end: 1, bytes: 8 })
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.uploadCorrelationInvalid, true)
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    assert.equal(snapshot.aggregate.scheduledUploadBytes, null)
    const later = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 1, relation: 'selection-window' })
    assert.equal(later.capability.observed, false)
    assert.match(later.capability.reason, /Upload correlation is incomplete/u)
    harness.recorder.dispose()
})

test('a target context getter cannot inject upload or readback evidence before window inspection', async () => {
    const harness = createHarness()
    const nestedMapping = deferred()
    let nestedObserved
    let uploadCalls = 0
    let readbackCalls = 0
    const target = harness.recorder.inspect({
        inspectionPurpose: 'local',
        get evidenceWindow() {
            harness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
                uploadCalls += 1
            })
            nestedObserved = harness.recorder.observeReadback(
                {
                    kind: 'buffer-map-read',
                    bytes: 4,
                    submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
                },
                () => {
                    readbackCalls += 1
                    return nestedMapping.promise
                }
            )
            return { startedAt: 0, endedAt: 1, relation: 'selection-window' }
        },
    })
    assert.equal(uploadCalls, 1)
    assert.equal(readbackCalls, 1)
    assert.equal(target.renderer.capability.observed, false)
    assert.match(target.renderer.capability.reason, /changed during target context inspection/u)
    nestedMapping.resolve('nested')
    assert.equal(await nestedObserved, 'nested')

    upload(harness, { start: 0, end: 1, bytes: 8 })
    const validMapping = deferred()
    harness.setTime(2)
    const validObserved = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 8,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => validMapping.promise
    )
    harness.setTime(3)
    validMapping.resolve('valid')
    assert.equal(await validObserved, 'valid')

    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.uploadCorrelationInvalid, true)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.aggregate.uploadCallMsP95, null)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    const later = harness.recorder.inspectWindow({ startedAt: 0, endedAt: 3, relation: 'selection-window' })
    assert.equal(later.capability.observed, false)
    assert.match(later.capability.reason, /correlation is incomplete/u)
    harness.recorder.dispose()
})

test('inspection requested during transfer work never evaluates a target context getter', async () => {
    const uploadHarness = createHarness()
    let uploadGetterReads = 0
    let nestedReadbackCalls = 0
    let uploadInspection
    uploadHarness.setTime(0)
    uploadHarness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
        uploadInspection = uploadHarness.recorder.inspect({
            inspectionPurpose: 'local',
            get evidenceWindow() {
                uploadGetterReads += 1
                uploadHarness.recorder.observeReadback(
                    {
                        kind: 'buffer-map-read',
                        bytes: 4,
                        submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
                    },
                    () => {
                        nestedReadbackCalls += 1
                        return Promise.resolve()
                    }
                )
                return { startedAt: 0, endedAt: 1, relation: 'selection-window' }
            },
        })
        uploadHarness.setTime(1)
    })
    assert.equal(uploadGetterReads, 0)
    assert.equal(nestedReadbackCalls, 0)
    assert.equal(uploadInspection, null)
    const uploadSnapshot = uploadHarness.recorder.getSnapshot()
    assert.equal(uploadSnapshot.acceptedUploadCount, 1)
    assert.equal(uploadSnapshot.uploadCorrelationInvalid, false)
    assert.equal(uploadSnapshot.readbackCorrelationInvalid, false)
    uploadHarness.recorder.dispose()

    const readbackHarness = createHarness()
    const mapping = deferred()
    let readbackGetterReads = 0
    let nestedUploadCalls = 0
    let readbackInspection
    readbackHarness.setTime(0)
    const observed = readbackHarness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => {
            readbackInspection = readbackHarness.recorder.inspect({
                inspectionPurpose: 'local',
                get evidenceWindow() {
                    readbackGetterReads += 1
                    readbackHarness.recorder.measureUpload({ kind: 'queue-write-buffer', bytes: 4 }, () => {
                        nestedUploadCalls += 1
                    })
                    return { startedAt: 0, endedAt: 1, relation: 'selection-window' }
                },
            })
            return mapping.promise
        }
    )
    assert.equal(readbackGetterReads, 0)
    assert.equal(nestedUploadCalls, 0)
    assert.equal(readbackInspection, null)
    readbackHarness.setTime(1)
    mapping.resolve(undefined)
    await observed
    const readbackSnapshot = readbackHarness.recorder.getSnapshot()
    assert.equal(readbackSnapshot.acceptedReadbackCount, 1)
    assert.equal(readbackSnapshot.uploadCorrelationInvalid, false)
    assert.equal(readbackSnapshot.readbackCorrelationInvalid, false)
    readbackHarness.recorder.dispose()
})

test('readback setup throws synchronously and Promise subclasses still produce a base derived Promise', async () => {
    const harness = createHarness()
    const expected = new Error('map setup failed')
    harness.setTime(0)
    assert.throws(
        () =>
            harness.recorder.observeReadback(
                {
                    kind: 'buffer-map-read',
                    bytes: 4,
                    submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
                },
                () => {
                    harness.setTime(1)
                    throw expected
                }
            ),
        error => error === expected
    )

    class BrandedPromise extends Promise {
        static get [Symbol.species]() {
            return Promise
        }
    }
    let resolveSource
    const source = new BrandedPromise(resolve => {
        resolveSource = resolve
    })
    harness.setTime(2)
    const observed = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => source
    )
    assert.notEqual(observed, source)
    assert.equal(observed.constructor, Promise)
    harness.setTime(3)
    resolveSource('mapped')
    assert.equal(await observed, 'mapped')
    assert.equal(harness.recorder.getSnapshot().rejectedReadbackCount, 1)
    harness.recorder.dispose()
})

test('overridden Promise methods cannot replace the returned Promise or leak pending evidence', async () => {
    const harness = createHarness()
    const source = Promise.resolve('mapped')
    Object.defineProperty(source, 'then', {
        value() {
            return 42
        },
    })
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => source
    )
    assert.equal(observed instanceof Promise, true)
    assert.notEqual(observed, 42)
    harness.setTime(1)
    assert.equal(await observed, 'mapped')
    assert.equal(harness.recorder.getSnapshot().pendingReadbackCount, 0)
    assert.equal(harness.recorder.getSnapshot().acceptedReadbackCount, 1)

    harness.recorder.dispose()
    const disabledSource = Promise.resolve('disabled')
    Object.defineProperty(disabledSource, 'then', {
        value() {
            return 42
        },
    })
    const disabled = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => disabledSource
    )
    assert.equal(disabled instanceof Promise, true)
    assert.equal(await disabled, 'disabled')
})

test('overriding the captured then function call property cannot break readback or device-loss observation', async () => {
    const thenFunction = Promise.prototype.then
    const previousCallDescriptor = Object.getOwnPropertyDescriptor(thenFunction, 'call')
    Object.defineProperty(thenFunction, 'call', {
        configurable: true,
        value() {
            return 42
        },
    })
    const harness = createHarness()
    try {
        const mapping = deferred()
        harness.setTime(0)
        const observed = harness.recorder.observeReadback(
            {
                kind: 'buffer-map-read',
                bytes: 4,
                submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
            },
            () => mapping.promise
        )
        harness.setTime(1)
        mapping.resolve('mapped')
        await flushPromises()
        assert.equal(harness.recorder.getSnapshot().pendingReadbackCount, 0)
        assert.equal(harness.recorder.getSnapshot().acceptedReadbackCount, 1)
        assert.equal(await observed, 'mapped')

        harness.lost.resolve({ reason: 'unknown' })
        await flushPromises()
        assert.equal(harness.recorder.getSnapshot().capability, 'device-lost')
    } finally {
        if (previousCallDescriptor) Object.defineProperty(thenFunction, 'call', previousCallDescriptor)
        else Reflect.deleteProperty(thenFunction, 'call')
        harness.recorder.dispose()
    }
})

test('a hostile Promise constructor returns the exact source while observation fails closed', async () => {
    const harness = createHarness()
    const source = Promise.resolve('mapped')
    const expected = new Error('hostile constructor')
    Object.defineProperty(source, 'constructor', {
        configurable: true,
        get() {
            throw expected
        },
    })
    harness.setTime(0)
    const observed = harness.recorder.observeReadback(
        {
            kind: 'buffer-map-read',
            bytes: 4,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => source
    )
    assert.equal(observed, source)
    const snapshot = harness.recorder.getSnapshot()
    assert.equal(snapshot.pendingReadbackCount, 0)
    assert.equal(snapshot.observerErrorCount, 1)
    assert.equal(snapshot.readbackCorrelationInvalid, true)
    assert.equal(snapshot.aggregate.hostObservedReadbackReadyMsP95, null)
    Reflect.deleteProperty(source, 'constructor')
    assert.equal(await observed, 'mapped')
    harness.recorder.dispose()
})

test('disabled recorder paths still return a derived Promise with exact settlement', async () => {
    const disposed = createHarness()
    disposed.recorder.dispose()
    const fulfilledSource = Promise.resolve({ exact: true })
    const fulfilled = disposed.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => fulfilledSource
    )
    assert.notEqual(fulfilled, fulfilledSource)
    assert.equal(await fulfilled, await fulfilledSource)

    const failed = createHarness()
    failed.lost.reject(new Error('observer unavailable'))
    await flushPromises()
    const expected = new Error('business rejection')
    const rejectedSource = Promise.reject(expected)
    const rejected = failed.recorder.observeReadback(
        { kind: 'buffer-map-read', bytes: 4, submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted' },
        () => rejectedSource
    )
    assert.notEqual(rejected, rejectedSource)
    await assert.rejects(rejected, error => error === expected)
    failed.recorder.dispose()
})
