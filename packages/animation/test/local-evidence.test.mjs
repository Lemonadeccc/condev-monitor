import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_LOCAL_EVIDENCE_VERSION, projectAnimationLocalEvidenceSnapshot } from '../build/esm/index.mjs'

const sourceStatus = status => ({
    'gsap-ticker': status,
    'lenis-scroll': 'not-configured',
    'scroll-trigger': 'not-configured',
})

const checkpoint = (boundary, status = 'measured') => ({
    boundary,
    capturedAt: 100,
    status,
    configuredSourceCount: 1,
    measuredSourceCount: status === 'measured' ? 1 : 0,
    unobservedSourceCount: status === 'not-observed' ? 1 : 0,
    errorSourceCount: 0,
    sourceStatus: sourceStatus(status === 'measured' ? 'measured' : 'not-observed'),
    gsapTicker: { hostileHostReference: globalThis },
    lenisScroll: null,
    scrollTrigger: null,
})

const mediaAttempt = index => ({
    attemptId: index,
    label: `private-${index}`,
    url: `https://private.example/${index}`,
    kind: 'video',
    outcome: 'completed',
    startedAt: index,
    endedAt: index + 30,
    durationMs: 30,
    decodeReady: {
        stage: 'decode-ready',
        timestampMs: index + 10,
        elapsedMs: 10,
        durationMs: 4,
        byteCount: 128,
        itemCount: 1,
        element: globalThis,
    },
    uploadReady: {
        stage: 'upload-ready',
        timestampMs: index + 20,
        elapsedMs: 20,
        durationMs: 3,
        byteCount: 128,
        itemCount: 1,
    },
    firstVisible: {
        stage: 'first-visible',
        timestampMs: index + 25,
        elapsedMs: 25,
        durationMs: null,
        byteCount: null,
        itemCount: null,
    },
})

const motionInteraction = index => ({
    id: `private-motion-${index}`,
    label: `private-label-${index}`,
    kind: 'scroll',
    outcome: 'completed',
    startedAt: index,
    endedAt: index + 40,
    durationMs: 40,
    quality: { privateHost: globalThis },
    before: checkpoint('before-interaction'),
    after: checkpoint('after-interaction'),
})

test('local evidence projection is versioned, bounded, and strips identity and host references', () => {
    const projected = projectAnimationLocalEvidenceSnapshot({
        version: ANIMATION_LOCAL_EVIDENCE_VERSION,
        droppedProviderCount: 2,
        providers: [
            {
                kind: 'media',
                snapshot: {
                    droppedAttemptCount: 3,
                    attempts: Array.from({ length: 40 }, (_, index) => mediaAttempt(index)),
                },
            },
            {
                kind: 'motion',
                snapshot: {
                    droppedInteractionCount: 4,
                    interactions: Array.from({ length: 40 }, (_, index) => motionInteraction(index)),
                },
            },
        ],
    })

    assert.equal(projected.version, 1)
    assert.equal(projected.providerCount, 2)
    assert.equal(projected.droppedProviderCount, 2)
    assert.equal(projected.media.retainedRecordCount, 32)
    assert.equal(projected.media.droppedRecordCount, 11)
    assert.equal(projected.motion.retainedRecordCount, 32)
    assert.equal(projected.motion.droppedRecordCount, 12)
    assert.equal(projected.truncated, true)
    assert.deepEqual(projected.media.records[0], {
        kind: 'video',
        outcome: 'completed',
        durationMs: 30,
        decodeReady: { stage: 'decode-ready', elapsedMs: 10, durationMs: 4, byteCount: 128, itemCount: 1 },
        uploadReady: { stage: 'upload-ready', elapsedMs: 20, durationMs: 3, byteCount: 128, itemCount: 1 },
        firstVisible: { stage: 'first-visible', elapsedMs: 25, durationMs: null, byteCount: null, itemCount: null },
    })
    const serialized = JSON.stringify(projected)
    assert.doesNotMatch(serialized, /private|example|attemptId|element|hostileHostReference|quality|startedAt|endedAt/)
    assert.equal(Object.isFrozen(projected), true)
    assert.equal(Object.isFrozen(projected.media.records), true)
})

test('local evidence projection accepts its own closed output and fails closed around hostile providers', () => {
    const closed = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providers: [
            { kind: 'media', snapshot: { attempts: [mediaAttempt(1)], droppedAttemptCount: 0 } },
            { kind: 'motion', snapshot: { interactions: [motionInteraction(1)], droppedInteractionCount: 0 } },
        ],
    })
    assert.deepEqual(projectAnimationLocalEvidenceSnapshot(closed), closed)

    const hostileProvider = {}
    Object.defineProperty(hostileProvider, 'kind', {
        get() {
            throw new Error('hostile getter')
        },
    })
    const isolated = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providers: [hostileProvider, { kind: 'media', snapshot: { attempts: [mediaAttempt(2)], droppedAttemptCount: 0 } }],
    })
    assert.equal(isolated.providerCount, 1)
    assert.equal(isolated.rejectedProviderCount, 1)
    assert.equal(isolated.media.retainedRecordCount, 1)

    const hostileRoot = {}
    Object.defineProperty(hostileRoot, 'version', {
        get() {
            throw new Error('hostile root')
        },
    })
    assert.equal(projectAnimationLocalEvidenceSnapshot(hostileRoot), null)
    assert.equal(projectAnimationLocalEvidenceSnapshot({ version: 2, providers: [] }), null)
})

test('local evidence projection caps provider inspection and rejects malformed records without coercion', () => {
    const providers = Array.from({ length: 20 }, () => ({
        kind: 'media',
        snapshot: { attempts: [{ ...mediaAttempt(1), durationMs: '30' }], droppedAttemptCount: 0 },
    }))
    const projected = projectAnimationLocalEvidenceSnapshot({ version: 1, providers })
    assert.equal(projected.providerCount, 16)
    assert.equal(projected.droppedProviderCount, 4)
    assert.equal(projected.media.retainedRecordCount, 0)
    assert.equal(projected.media.droppedRecordCount, 16)
})

test('local evidence projection bounds record inspection for huge sparse or proxied arrays', () => {
    let recordReads = 0
    const attempts = new Array(2_000_000)
    const proxiedAttempts = new Proxy(attempts, {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/u.test(property)) {
                recordReads += 1
                return mediaAttempt(Number(property))
            }
            return Reflect.get(target, property, receiver)
        },
    })

    const projected = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providers: [{ kind: 'media', snapshot: { attempts: proxiedAttempts, droppedAttemptCount: 0 } }],
    })

    assert.equal(recordReads, 64)
    assert.equal(projected.media.retainedRecordCount, 32)
    assert.equal(projected.media.droppedRecordCount, 1_999_968)
    assert.equal(projected.media.truncated, true)
})

test('local evidence projection rejects contradictory motion checkpoints and invalid loss metadata', () => {
    const contradictory = motionInteraction(1)
    contradictory.after = {
        ...contradictory.after,
        status: 'not-instrumented',
        configuredSourceCount: 0,
        measuredSourceCount: 0,
        sourceStatus: {
            'gsap-ticker': 'measured',
            'lenis-scroll': 'measured',
            'scroll-trigger': 'measured',
        },
    }
    const projected = projectAnimationLocalEvidenceSnapshot({
        version: 1,
        providers: [
            { kind: 'motion', snapshot: { interactions: [contradictory], droppedInteractionCount: 0 } },
            { kind: 'media', snapshot: { attempts: [mediaAttempt(1)], droppedAttemptCount: 'unknown' } },
        ],
    })

    assert.equal(projected.providerCount, 1)
    assert.equal(projected.rejectedProviderCount, 1)
    assert.equal(projected.motion.retainedRecordCount, 0)
    assert.equal(projected.motion.droppedRecordCount, 1)
    assert.equal(projectAnimationLocalEvidenceSnapshot({ version: 1, providers: [], droppedProviderCount: 'unknown' }), null)
})
