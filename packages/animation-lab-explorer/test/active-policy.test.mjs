import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveActiveExplorerPolicy, toUploadSafeActiveAnimationExploration } from '../build/esm/index.js'

test('active explorer policy stays bounded and rejects unsupported action kinds', () => {
    const policy = resolveActiveExplorerPolicy({ maxRoutes: 2, maxEdges: 5, allowedKinds: ['click', 'hover'] })
    assert.equal(policy.maxRoutes, 2)
    assert.equal(policy.maxEdges, 5)
    assert.deepEqual(policy.allowedKinds, ['click', 'hover'])
    assert.equal(policy.blockMutationRequests, true)
    assert.equal(policy.allowDevelopmentHmr, false)
    assert.equal(resolveActiveExplorerPolicy({ allowDevelopmentHmr: true }).allowDevelopmentHmr, true)
    assert.throws(() => resolveActiveExplorerPolicy({ allowDevelopmentHmr: 'false' }), /allowDevelopmentHmr must be a boolean/u)
    assert.throws(() => resolveActiveExplorerPolicy({ allowDevelopmentHmr: 1 }), /allowDevelopmentHmr must be a boolean/u)
    assert.throws(() => resolveActiveExplorerPolicy({ blockMutationRequests: 'false' }), /blockMutationRequests must be a boolean/u)
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
        authentication: 'required-local-storage-state',
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
                limitations: ['outcome-needs-review', 'renderer-adapter-error'],
                localOnly: {
                    rendererObjects: [
                        {
                            subjectKey: 'private.renderer.subject',
                            surface: 'webgl',
                            resolution: 'hit',
                            selector: '#secret-canvas',
                            outcomeKey: 'private.renderer.outcome',
                            outcomeStatus: 'completed',
                            adapterError: true,
                        },
                    ],
                },
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
        limitations: ['bounded-exploration', 'renderer-adapter-error'],
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
    assert.equal(json.includes('private.renderer.subject'), false)
    assert.equal(json.includes('private.renderer.outcome'), false)
    assert.equal(json.includes('#secret-canvas'), false)
    assert.equal(safe.authentication, 'required-local-storage-state')
    assert.notEqual(safe.states[0].semanticHash, local.states[0].semanticHash)
    assert.notEqual(safe.states[0].motionInventoryHash, local.states[0].motionInventoryHash)
    assert.notEqual(safe.targets[0].targetId, local.targets[0].targetId)
    assert.notEqual(safe.motions[0].fingerprint, local.motions[0].fingerprint)
    assert.equal(safe.motions[0].targetId, safe.targets[0].targetId)
    assert.equal(safe.edges[0].motionIds[0], safe.motions[0].motionId)
    assert.equal(safe.privacy.urlsIncluded, false)
    assert.equal(safe.reviewRequired, true)
})

test('legacy local sessions do not invent unauthenticated provenance', () => {
    const local = {
        schemaVersion: 1,
        dataClassification: 'local-only',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey: 'legacy.page',
        browser: { driver: 'playwright', engine: 'chromium' },
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:00:01.000Z',
        policy: resolveActiveExplorerPolicy(),
        routes: [],
        states: [],
        targets: [],
        edges: [],
        motions: [],
        coverage: {
            claim: 'bounded-safe-reachable-state-exploration',
            complete: false,
            discoveredRoutes: 0,
            discoveredStates: 0,
            candidateEdges: 0,
            executedEdges: 0,
            observedMotions: 0,
            completedMotions: 0,
            quarantinedEdges: 0,
            failedEdges: 0,
            stoppedByBounds: false,
            uncoveredReasonCounts: {},
            warning: 'legacy',
        },
        stopReasons: [],
        limitations: [],
        review: { required: true, warnings: [] },
    }
    assert.equal(toUploadSafeActiveAnimationExploration(local).authentication, 'unknown')
})
