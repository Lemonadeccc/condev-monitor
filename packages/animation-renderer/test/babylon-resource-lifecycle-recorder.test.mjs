import assert from 'node:assert/strict'
import test from 'node:test'

import { createBabylonResourceLifecycleRecorder } from '../build/esm/index.mjs'

const createRecorder = options =>
    createBabylonResourceLifecycleRecorder({
        lifecycleCoverage: 'caller-attests-complete-resource-lifecycle-from-empty-scene',
        ...options,
    })

const zeroCounts = {
    geometry: 0,
    texture: 0,
    'render-target': 0,
    material: 0,
    effect: 0,
    buffer: 0,
    other: 0,
}

test('tracks explicit current, peak, release, and checkpoint leak-candidate counts', () => {
    const recorder = createRecorder({ candidateAfterCheckpoints: 2 })
    const geometry = {}
    const texture = {}
    const replacementGeometry = {}

    assert.equal(recorder.recordCreated(geometry, 'geometry'), true)
    assert.equal(recorder.recordCreated(texture, 'texture'), true)
    assert.deepEqual(recorder.captureCheckpoint(), {
        backend: 'babylon-resource-lifecycle',
        capability: 'active',
        evidenceLevel: 'caller-attested',
        candidateBasis: 'unreleased-across-explicit-checkpoints',
        checkpointCount: 1,
        candidateAfterCheckpoints: 2,
        acceptedCreatedCount: 2,
        acceptedReleasedCount: 0,
        rejectedEventCount: 0,
        current: { ...zeroCounts, geometry: 1, texture: 1 },
        peak: { ...zeroCounts, geometry: 1, texture: 1 },
        peakTotal: 2,
        leakCandidates: zeroCounts,
        leakCandidateTotal: 0,
    })

    assert.equal(recorder.recordReleased(geometry), true)
    assert.equal(recorder.recordCreated(replacementGeometry, 'geometry'), true)
    const second = recorder.captureCheckpoint()
    assert.deepEqual(second.current, { ...zeroCounts, geometry: 1, texture: 1 })
    assert.deepEqual(second.peak, { ...zeroCounts, geometry: 1, texture: 1 })
    assert.equal(second.peakTotal, 2)
    assert.deepEqual(second.leakCandidates, { ...zeroCounts, texture: 1 })
    assert.equal(second.leakCandidateTotal, 1)
    assert.equal(second.acceptedCreatedCount, 3)
    assert.equal(second.acceptedReleasedCount, 1)
    assert.equal(Object.isFrozen(second), true)
    assert.equal(Object.isFrozen(second.current), true)
    recorder.dispose()
})

test('uses object identity without reading application resources and supports valid identity reuse after release', () => {
    const recorder = createRecorder()
    const resource = new Proxy(
        {},
        {
            get() {
                assert.fail('recorder must not inspect Babylon resource properties')
            },
        }
    )

    assert.equal(recorder.recordCreated(resource, 'material'), true)
    assert.equal(recorder.recordReleased(resource), true)
    assert.equal(recorder.recordCreated(resource, 'texture'), true)
    assert.deepEqual(recorder.getSnapshot().current, { ...zeroCounts, texture: 1 })
    assert.equal(recorder.getSnapshot().rejectedEventCount, 0)
    recorder.dispose()
})

test('permanently downgrades lifecycle totals after a duplicate or untracked event', () => {
    const recorder = createRecorder()
    const resource = {}

    assert.equal(recorder.recordCreated(resource, 'material'), true)
    assert.equal(recorder.recordCreated(resource, 'texture'), false)
    assert.equal(recorder.recordReleased({}), false)

    const snapshot = recorder.getSnapshot()
    assert.equal(snapshot.capability, 'incomplete')
    assert.equal(snapshot.rejectedEventCount, 2)
    assert.equal(snapshot.current, null)
    assert.equal(snapshot.peak, null)
    assert.equal(snapshot.leakCandidates, null)
    recorder.dispose()
})

test('capacity loss permanently downgrades aggregate and candidate counts instead of reporting partial totals', () => {
    const recorder = createRecorder({ maxLiveResources: 1, candidateAfterCheckpoints: 1 })
    assert.equal(recorder.recordCreated({}, 'geometry'), true)
    assert.equal(recorder.recordCreated({}, 'texture'), false)
    const snapshot = recorder.captureCheckpoint()

    assert.equal(snapshot.capability, 'incomplete')
    assert.equal(snapshot.acceptedCreatedCount, 1)
    assert.equal(snapshot.rejectedEventCount, 1)
    assert.equal(snapshot.current, null)
    assert.equal(snapshot.peak, null)
    assert.equal(snapshot.peakTotal, null)
    assert.equal(snapshot.leakCandidates, null)
    assert.equal(snapshot.leakCandidateTotal, null)
    recorder.dispose()
})

test('invalid runtime events fail closed and disposal releases retained anonymous records', () => {
    const recorder = createRecorder()
    assert.equal(recorder.recordCreated(null, 'geometry'), false)
    assert.equal(recorder.recordCreated({}, 'unknown-kind'), false)
    assert.equal(recorder.recordReleased({}), false)
    assert.equal(recorder.recordCreated({}, 'buffer'), true)
    recorder.dispose()
    recorder.dispose()

    const snapshot = recorder.getSnapshot()
    assert.equal(snapshot.capability, 'disposed')
    assert.equal(snapshot.current, null)
    assert.equal(snapshot.peak, null)
    assert.equal(snapshot.leakCandidates, null)
    assert.equal(recorder.recordCreated({}, 'buffer'), false)
    assert.equal(recorder.recordReleased({}), false)
    assert.equal(recorder.captureCheckpoint().checkpointCount, snapshot.checkpointCount)
})

test('requires explicit coverage and bounded recorder options', () => {
    assert.throws(() => createBabylonResourceLifecycleRecorder({}), /lifecycleCoverage/)
    assert.throws(() => createRecorder({ candidateAfterCheckpoints: 0 }), /candidateAfterCheckpoints/)
    assert.throws(() => createRecorder({ maxLiveResources: 65_537 }), /maxLiveResources/)
})
