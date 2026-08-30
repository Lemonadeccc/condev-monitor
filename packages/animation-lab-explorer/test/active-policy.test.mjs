import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveActiveExplorerPolicy, toUploadSafeActiveAnimationExploration } from '../build/esm/index.js'

test('active explorer policy stays bounded and rejects unsupported action kinds', () => {
    const policy = resolveActiveExplorerPolicy({ maxRoutes: 2, maxEdges: 5, allowedKinds: ['click', 'hover'] })
    assert.equal(policy.maxRoutes, 2)
    assert.equal(policy.maxEdges, 5)
    assert.deepEqual(policy.allowedKinds, ['click', 'hover'])
    assert.equal(policy.blockMutationRequests, true)
    assert.throws(() => resolveActiveExplorerPolicy({ maxStates: 0 }), /maxStates/u)
    assert.throws(() => resolveActiveExplorerPolicy({ allowedKinds: ['submit'] }), /allowedKinds/u)
})

test('upload-safe active exploration projection strips local navigation and target evidence', () => {
    const policy = resolveActiveExplorerPolicy({ maxRoutes: 1, maxStates: 1, maxEdges: 1 })
    const local = {
        schemaVersion: 1,
        dataClassification: 'local-only',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey: 'fixture.page',
        browser: { driver: 'playwright', engine: 'chromium', version: '1.0' },
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:00:01.000Z',
        policy,
        routes: [{ routeId: 'route-1', routeKey: 'fixture.page', localUrl: 'https://secret.example/private', stateIds: ['state-1'] }],
        states: [
            {
                stateId: 'state-1',
                routeId: 'route-1',
                depth: 0,
                semanticHash: 'abc',
                visualHash: 'secret-visual',
                targetCount: 1,
                motionInventoryHash: 'def',
                replayEdgeIds: ['edge-secret'],
            },
        ],
        targets: [{ targetId: 'target-1', stateId: 'state-1', surface: 'dom', localOnly: { selector: '#secret', label: 'Private' } }],
        edges: [
            {
                edgeId: 'edge-1',
                fromStateId: 'state-1',
                toStateId: 'state-1',
                routeId: 'route-1',
                depth: 0,
                action: { actionId: 'action-1', candidateId: 'candidate-1', kind: 'click', selector: '#secret', durationMs: 100 },
                status: 'executed',
                motionIds: ['motion-1'],
                startedAtMs: 0,
                endedAtMs: 100,
                blockedMutationRequests: 0,
                limitations: ['outcome-needs-review'],
            },
        ],
        motions: [
            {
                motionId: 'motion-1',
                fingerprint: 'fingerprint-1',
                routeId: 'route-1',
                stateId: 'state-1',
                edgeId: 'edge-1',
                targetId: 'target-1',
                family: 'css-transition',
                engine: 'browser-native',
                status: 'completed',
                timing: { declaredDurationMs: 100, observedActiveMs: 100, infinite: false },
                properties: ['transform'],
                lifecycle: ['transitionend'],
                evidenceKinds: ['browser-direct'],
                evidenceConfidence: 'high',
                causality: 'direct-api',
                limitations: ['temporal-correlation'],
                observedInstances: 1,
                localOnly: { selector: '#secret', animationName: 'privateAnimation' },
            },
        ],
        coverage: {
            claim: 'bounded-safe-reachable-state-exploration',
            complete: false,
            discoveredRoutes: 1,
            discoveredStates: 1,
            candidateEdges: 1,
            executedEdges: 1,
            observedMotions: 1,
            completedMotions: 1,
            quarantinedEdges: 0,
            failedEdges: 0,
            stoppedByBounds: false,
            uncoveredReasonCounts: {},
            warning: 'bounded',
        },
        stopReasons: ['candidate-queue-exhausted'],
        limitations: ['bounded-exploration'],
        review: { required: true, warnings: ['review'] },
    }

    const safe = toUploadSafeActiveAnimationExploration(local)
    const json = JSON.stringify(safe)
    assert.equal(json.includes('secret.example'), false)
    assert.equal(json.includes('#secret'), false)
    assert.equal(json.includes('Private'), false)
    assert.equal(json.includes('privateAnimation'), false)
    assert.equal(json.includes('secret-visual'), false)
    assert.equal(json.includes('edge-secret'), false)
    assert.equal(safe.privacy.urlsIncluded, false)
    assert.equal(safe.reviewRequired, true)
})
