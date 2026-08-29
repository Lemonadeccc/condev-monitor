import assert from 'node:assert/strict'
import test from 'node:test'

import { createMediaSemanticStageRecorder } from '../build/esm/index.mjs'

test('records explicit ordered media stages as frozen local-only evidence', () => {
    const recorder = createMediaSemanticStageRecorder()
    const attempt = recorder.begin('video', 100)
    assert.equal(attempt.decodeReady({ timestampMs: 112, durationMs: 8, byteCount: 4_096, itemCount: 1 }), true)
    assert.equal(attempt.uploadReady({ timestampMs: 120, durationMs: 4, byteCount: 4_096, itemCount: 1 }), true)
    assert.equal(attempt.firstVisible({ timestampMs: 132, itemCount: 1 }), true)
    const result = attempt.end(140)

    assert.deepEqual(result, {
        attemptId: 1,
        kind: 'video',
        outcome: 'completed',
        startedAt: 100,
        endedAt: 140,
        durationMs: 40,
        decodeReady: {
            stage: 'decode-ready',
            timestampMs: 112,
            elapsedMs: 12,
            durationMs: 8,
            byteCount: 4_096,
            itemCount: 1,
        },
        uploadReady: {
            stage: 'upload-ready',
            timestampMs: 120,
            elapsedMs: 20,
            durationMs: 4,
            byteCount: 4_096,
            itemCount: 1,
        },
        firstVisible: {
            stage: 'first-visible',
            timestampMs: 132,
            elapsedMs: 32,
            durationMs: null,
            byteCount: null,
            itemCount: 1,
        },
    })
    assert.equal(attempt.status, 'completed')
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.decodeReady), true)
    assert.equal(attempt.end(999), result)
    assert.deepEqual(recorder.snapshot().attempts, [result])
})

test('supports omitted stages without inventing evidence', () => {
    const result = createMediaSemanticStageRecorder().begin('image', 10).end(15)
    assert.equal(result.decodeReady, null)
    assert.equal(result.uploadReady, null)
    assert.equal(result.firstVisible, null)
})

test('rejects duplicate, out-of-order and invalid stage values without advancing state', () => {
    const attempt = createMediaSemanticStageRecorder().begin('webgpu', 100)
    assert.equal(attempt.decodeReady({ timestampMs: 99 }), false)
    assert.equal(attempt.decodeReady({ timestampMs: Number.NaN }), false)
    assert.equal(attempt.decodeReady({ timestampMs: 110, byteCount: -1 }), false)
    assert.equal(attempt.decodeReady({ timestampMs: 110, byteCount: 1_000_000_000_001 }), false)
    assert.equal(attempt.decodeReady({ timestampMs: 700_101 }), false)
    assert.equal(attempt.decodeReady({ timestampMs: 110, durationMs: 11 }), false)
    assert.equal(attempt.decodeReady({ timestampMs: 110, byteCount: 10 }), true)
    assert.equal(attempt.decodeReady({ timestampMs: 111 }), false)
    assert.equal(attempt.firstVisible({ timestampMs: 130 }), true)
    assert.equal(attempt.uploadReady({ timestampMs: 131 }), false)
    assert.throws(() => attempt.end(129), /ordered finite terminal timestamp/)
    const result = attempt.end(140)
    assert.equal(result.decodeReady.byteCount, 10)
    assert.equal(result.uploadReady, null)
    assert.equal(result.firstVisible.timestampMs, 130)
})

test('fails closed on getters and never retains arbitrary host fields', () => {
    const recorder = createMediaSemanticStageRecorder()
    const attempt = recorder.begin('canvas', 0)
    let dangerousReads = 0
    const hostile = {
        get timestampMs() {
            dangerousReads += 1
            throw new Error('private host getter')
        },
        url: 'https://private.example/video.mp4',
        selector: '#private-player',
        element: { src: 'secret' },
        metadata: { userId: 42 },
    }
    assert.equal(attempt.decodeReady(hostile), false)
    assert.equal(dangerousReads, 1)
    let arbitraryReads = 0
    assert.equal(
        attempt.uploadReady({
            timestampMs: 5,
            byteCount: 1,
            get url() {
                arbitraryReads += 1
                throw new Error('must not inspect arbitrary fields')
            },
        }),
        true
    )
    assert.equal(arbitraryReads, 0)
    const result = attempt.end(10)
    assert.equal(JSON.stringify(result).includes('private'), false)
    assert.deepEqual(Object.keys(result.uploadReady), ['stage', 'timestampMs', 'elapsedMs', 'durationMs', 'byteCount', 'itemCount'])
})

test('bounds completed records and separately bounds active attempts', () => {
    const recorder = createMediaSemanticStageRecorder({ capacity: 2, maximumActiveAttempts: 2 })
    const first = recorder.begin('image', 0)
    const second = recorder.begin('video', 0)
    assert.throws(() => recorder.begin('canvas', 0), /Cannot exceed 2 active/)
    first.end(1)
    second.end(2)
    recorder.begin('webgl', 3).end(4)
    const snapshot = recorder.snapshot()
    assert.equal(snapshot.begunAttemptCount, 3)
    assert.equal(snapshot.activeAttemptCount, 0)
    assert.equal(snapshot.retainedAttemptCount, 2)
    assert.equal(snapshot.droppedAttemptCount, 1)
    assert.equal(snapshot.truncated, true)
    assert.deepEqual(
        snapshot.attempts.map(attempt => attempt.attemptId),
        [2, 3]
    )
})

test('cancellation never claims completion or first-visible evidence', () => {
    const recorder = createMediaSemanticStageRecorder()
    const attempt = recorder.begin('video', 100)
    assert.equal(attempt.firstVisible({ timestampMs: 110, itemCount: 1 }), true)
    const result = attempt.cancel(115)
    assert.equal(attempt.status, 'cancelled')
    assert.equal(result.outcome, 'cancelled')
    assert.equal(result.firstVisible, null)
    assert.deepEqual([recorder.snapshot().completedAttemptCount, recorder.snapshot().cancelledAttemptCount], [0, 1])
})

test('settled handles expose only detached idempotent result behavior', () => {
    const recorder = createMediaSemanticStageRecorder()
    const attempt = recorder.begin('custom', 10)
    const result = attempt.end(20)
    recorder.begin('image', 30).end(40)
    recorder.dispose()

    assert.equal(attempt.status, 'completed')
    assert.equal(attempt.decodeReady({ timestampMs: 15 }), false)
    assert.equal(attempt.uploadReady({ timestampMs: 15 }), false)
    assert.equal(attempt.firstVisible({ timestampMs: 15 }), false)
    assert.equal(attempt.end(Number.NaN), result)
    assert.equal(attempt.cancel(Number.NaN), result)
})

test('dispose deterministically seals input and cancels every active attempt', () => {
    const recorder = createMediaSemanticStageRecorder()
    const first = recorder.begin('video', 25)
    const second = recorder.begin('webgl', 30)
    assert.equal(first.decodeReady({ timestampMs: 35 }), true)
    assert.equal(second.firstVisible({ timestampMs: 40 }), true)

    recorder.dispose()
    recorder.dispose()

    const snapshot = recorder.snapshot()
    assert.equal(snapshot.status, 'disposed')
    assert.equal(snapshot.activeAttemptCount, 0)
    assert.equal(snapshot.cancelledAttemptCount, 2)
    assert.equal(
        snapshot.attempts.every(result => result.outcome === 'cancelled' && result.firstVisible === null),
        true
    )
    assert.equal(first.uploadReady({ timestampMs: 45 }), false)
    assert.equal(second.status, 'cancelled')
    assert.throws(() => recorder.begin('custom', 50), /after recorder disposal/)
})

test('hostile stage projection cannot add evidence during reentrant disposal', () => {
    const recorder = createMediaSemanticStageRecorder()
    const attempt = recorder.begin('video', 0)
    const input = {
        get timestampMs() {
            recorder.dispose()
            return 5
        },
        byteCount: 10,
    }

    assert.equal(attempt.decodeReady(input), false)
    assert.equal(attempt.status, 'cancelled')
    assert.equal(recorder.snapshot().attempts[0].decodeReady, null)
    assert.equal(recorder.snapshot().status, 'disposed')
})

test('notifies an isolated observer exactly once for each immutable settled attempt', () => {
    const observed = []
    const recorder = createMediaSemanticStageRecorder(
        {},
        {
            onAttemptSettled(record) {
                observed.push(record)
                throw new Error('observer failure must stay isolated')
            },
        }
    )
    const completed = recorder.begin('image', 10)
    const completedRecord = completed.end(20)
    assert.equal(completed.end(30), completedRecord)
    const cancelled = recorder.begin('video', 30)
    recorder.dispose()

    assert.equal(observed.length, 2)
    assert.equal(observed[0], completedRecord)
    assert.equal(observed[1], cancelled.cancel(40))
    assert.equal(Object.isFrozen(observed[1]), true)
})
