import assert from 'node:assert/strict'
import test from 'node:test'

import { activeExplorationMotionFamilies, parseLabActiveExploration } from './lab-active-exploration'

function session() {
    return {
        schemaVersion: 1,
        dataClassification: 'upload-safe',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey: 'fixture.page',
        browser: { driver: 'playwright', engine: 'chromium' },
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:00:01.000Z',
        policy: {
            maxRoutes: 1,
            maxStates: 2,
            maxEdges: 2,
            maxDepth: 1,
            maxActionsPerState: 1,
            maxTotalDurationMs: 1000,
            actionTimeoutMs: 500,
            settleIdleMs: 100,
            settleTimeoutMs: 500,
            maxMotionRecords: 10,
            allowedKinds: ['click'],
            blockMutationRequests: true,
        },
        routes: [{ routeId: 'route-1', routeKey: 'fixture.page', stateIds: ['state-1'] }],
        states: [
            {
                stateId: 'state-1',
                routeId: 'route-1',
                depth: 0,
                semanticHash: 'abc',
                targetCount: 1,
                motionInventoryHash: 'def',
            },
        ],
        targets: [],
        edges: [
            {
                edgeId: 'edge-1',
                fromStateId: 'state-1',
                toStateId: 'state-1',
                routeId: 'route-1',
                depth: 0,
                action: { actionId: 'action-1', kind: 'click', selector: undefined as string | undefined },
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
                family: 'css-transition',
                engine: 'browser-native',
                status: 'completed',
                timing: { infinite: false, observedActiveMs: 100 },
                properties: ['transform'],
                lifecycle: ['transitionend'],
                evidenceKinds: ['browser-event'],
                evidenceConfidence: 'high',
                causality: 'direct-api',
                limitations: ['temporal-correlation'],
                observedInstances: 1,
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
        reviewRequired: true,
        privacy: {
            urlsIncluded: false,
            selectorsIncluded: false,
            textIncluded: false,
            coordinatesIncluded: false,
            screenshotsIncluded: false,
            inputValuesIncluded: false,
            domIncluded: false,
        },
    }
}

test('parses bounded active exploration artifacts and summarizes motion families', () => {
    const parsed = parseLabActiveExploration(session())
    assert.equal(parsed.coverage.complete, false)
    assert.deepEqual(activeExplorationMotionFamilies(parsed), [{ family: 'css-transition', count: 1 }])
})

test('rejects forged completeness and oversized local evidence', () => {
    const complete = session()
    complete.coverage.complete = true
    assert.throws(() => parseLabActiveExploration(complete))

    const oversized = session()
    oversized.edges[0].action.selector = 'x'.repeat(2_000)
    assert.throws(() => parseLabActiveExploration(oversized))
})

test('rejects local-only fields forged into an upload-safe artifact', () => {
    const routeLeak = session()
    Object.assign(routeLeak.routes[0], { localUrl: 'https://private.example/account' })
    assert.throws(() => parseLabActiveExploration(routeLeak))

    const selectorLeak = session()
    selectorLeak.edges[0].action.selector = '#private-account'
    assert.throws(() => parseLabActiveExploration(selectorLeak))

    const motionLeak = session()
    Object.assign(motionLeak.motions[0], { localOnly: { selector: '#private-motion' } })
    assert.throws(() => parseLabActiveExploration(motionLeak))
})
