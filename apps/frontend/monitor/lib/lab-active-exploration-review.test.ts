import assert from 'node:assert/strict'
import test from 'node:test'

import { validateAnimationLabScenario } from '../../../../packages/animation-lab/src/scenario'
import { validateCoverageManifestForScenario } from '../../../backend/lab-runner/src/coverage'
import { parseLabActiveExploration } from './lab-active-exploration'
import {
    buildLabExplorerReviewedArtifacts,
    createInitialLabExplorerReviews,
    labExplorerRouteReadiness,
} from './lab-active-exploration-review'

function localSession() {
    return parseLabActiveExploration({
        schemaVersion: 1,
        dataClassification: 'local-only',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey: 'fixture.page',
        browser: { driver: 'playwright', engine: 'chromium' },
        authentication: 'required-local-storage-state',
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:00:01.000Z',
        policy: {
            maxRoutes: 1,
            maxStates: 2,
            maxEdges: 2,
            maxDepth: 1,
            maxActionsPerState: 2,
            maxTotalDurationMs: 1000,
            actionTimeoutMs: 500,
            settleIdleMs: 100,
            settleTimeoutMs: 500,
            maxMotionRecords: 10,
            allowedKinds: ['click', 'pointer-path'],
            blockMutationRequests: true,
        },
        routes: [{ routeId: 'route-1', routeKey: 'fixture.home', localUrl: 'http://127.0.0.1:43101/', stateIds: ['state-1'] }],
        states: [
            {
                stateId: 'state-1',
                routeId: 'route-1',
                depth: 0,
                semanticHash: 'abc',
                targetCount: 2,
                motionInventoryHash: 'def',
                replayEdgeIds: [],
            },
        ],
        targets: [],
        edges: [
            {
                edgeId: 'edge-click',
                fromStateId: 'state-1',
                toStateId: 'state-1',
                routeId: 'route-1',
                depth: 1,
                action: { actionId: 'action-click', kind: 'click', selector: '[data-lab="open"]' },
                status: 'executed',
                motionIds: ['motion-1'],
                startedAtMs: 0,
                endedAtMs: 100,
                blockedMutationRequests: 0,
                limitations: ['outcome-needs-review'],
            },
            {
                edgeId: 'edge-renderer',
                fromStateId: 'state-1',
                toStateId: 'state-1',
                routeId: 'route-1',
                depth: 1,
                action: {
                    actionId: 'action-renderer',
                    kind: 'pointer-path',
                    selector: 'canvas',
                    durationMs: 800,
                    points: [
                        { xRatio: 0.2, yRatio: 0.2 },
                        { xRatio: 0.8, yRatio: 0.8 },
                    ],
                },
                status: 'executed',
                motionIds: ['motion-2'],
                startedAtMs: 100,
                endedAtMs: 900,
                blockedMutationRequests: 0,
                limitations: ['outcome-needs-review'],
                localOnly: {
                    rendererObjects: [
                        {
                            subjectKey: 'fixture.mesh.primary',
                            surface: 'webgl',
                            resolution: 'hit',
                            selector: 'canvas',
                            outcomeKey: 'fixture.mesh.hit',
                            outcomeStatus: 'completed',
                        },
                    ],
                },
            },
        ],
        motions: [],
        coverage: {
            claim: 'bounded-safe-reachable-state-exploration',
            complete: false,
            discoveredRoutes: 1,
            discoveredStates: 1,
            candidateEdges: 2,
            executedEdges: 2,
            observedMotions: 2,
            completedMotions: 2,
            quarantinedEdges: 0,
            failedEdges: 0,
            stoppedByBounds: false,
            uncoveredReasonCounts: {},
            warning: 'bounded',
        },
        stopReasons: ['candidate-queue-exhausted'],
        limitations: ['bounded-exploration'],
    })
}

test('all discovered actions start needs-review and block export', () => {
    const session = localSession()
    const reviews = createInitialLabExplorerReviews(session)
    assert.equal(reviews['edge-click']?.decision, 'needs-review')
    assert.equal(reviews['edge-renderer']?.outcomeKind, 'registered-outcome')
    const readiness = labExplorerRouteReadiness(session, 'route-1', reviews)
    assert.equal(readiness.ready, false)
    assert.equal(readiness.pending, 2)
})

test('legacy artifacts without authentication provenance stay blocked', () => {
    const raw = structuredClone(localSession()) as Omit<ReturnType<typeof localSession>, 'authentication'> & {
        authentication?: ReturnType<typeof localSession>['authentication']
    }
    delete raw.authentication
    const session = parseLabActiveExploration(raw)
    assert.equal(session.authentication, 'unknown')
    const readiness = labExplorerRouteReadiness(session, 'route-1', createInitialLabExplorerReviews(session))
    assert.equal(readiness.ready, false)
    assert.ok(readiness.errors.some(error => error.includes('缺少认证来源')))
})

test('reviewed local actions produce a hash-bound Scenario and renderer coverage manifest', async () => {
    const session = localSession()
    const initial = createInitialLabExplorerReviews(session)
    const reviews = {
        ...initial,
        'edge-click': { ...initial['edge-click']!, decision: 'approved' as const, critical: true },
        'edge-renderer': { ...initial['edge-renderer']!, decision: 'approved' as const, critical: true },
    }
    assert.equal(labExplorerRouteReadiness(session, 'route-1', reviews).ready, true)
    const artifacts = await buildLabExplorerReviewedArtifacts(session, 'route-1', reviews)
    const scenario = artifacts.scenario as { actions: Array<Record<string, unknown>> }
    const coverage = artifacts.coverage as { localScenarioSha256: string; reviewStatus: string; items: Array<Record<string, unknown>> }
    assert.equal(scenario.actions.length, 2)
    assert.equal(coverage.reviewStatus, 'reviewed')
    assert.match(coverage.localScenarioSha256, /^[a-f0-9]{64}$/u)
    assert.equal(coverage.items[1]?.kind, 'renderer-object')
    assert.deepEqual(coverage.items[1]?.outcomeContract, { kind: 'registered-outcome', outcomeKey: 'fixture.mesh.hit' })
    assert.deepEqual(coverage.items[1]?.hit, {
        kind: 'renderer-adapter',
        adapterKey: 'renderer-object-resolver',
        objectKey: 'fixture.mesh.primary',
        strategy: 'raycast',
    })
    assert.equal(coverage.items[1]?.authentication, 'required-local-storage-state')
    const validation = validateAnimationLabScenario(artifacts.scenario)
    if (!validation.ok) assert.fail(validation.errors.join(', '))
    assert.doesNotThrow(() => validateCoverageManifestForScenario(artifacts.coverage, validation.value))
})

test('critical renderer actions require both hit evidence and a registered outcome', () => {
    const session = localSession()
    const initial = createInitialLabExplorerReviews(session)
    const reviews = {
        ...initial,
        'edge-click': { ...initial['edge-click']!, decision: 'rejected' as const },
        'edge-renderer': {
            ...initial['edge-renderer']!,
            decision: 'approved' as const,
            critical: true,
            outcomeKind: 'animations-settled' as const,
        },
    }
    const readiness = labExplorerRouteReadiness(session, 'route-1', reviews)
    assert.equal(readiness.ready, false)
    assert.ok(readiness.errors.some(error => error.includes('renderer-object')))
})

test('renderer coverage requires the exact outcome key declared by its adapter', () => {
    const session = localSession()
    const initial = createInitialLabExplorerReviews(session)
    const reviews = {
        ...initial,
        'edge-click': { ...initial['edge-click']!, decision: 'rejected' as const },
        'edge-renderer': {
            ...initial['edge-renderer']!,
            decision: 'approved' as const,
            critical: true,
            outcomeKind: 'registered-outcome' as const,
            outcomeKey: 'another.feature.completed',
        },
    }
    const readiness = labExplorerRouteReadiness(session, 'route-1', reviews)
    assert.equal(readiness.ready, false)
    assert.ok(readiness.errors.some(error => error.includes('同一个 registered outcome')))
})

test('review export rejects unsafe URLs, out-of-range actions, and ambiguous renderer hits', () => {
    const session = structuredClone(localSession())
    session.routes[0]!.localUrl = 'javascript:alert(1)'
    session.edges[0]!.action.durationMs = 120_001
    session.edges[1]!.localOnly!.rendererObjects.push({
        ...session.edges[1]!.localOnly!.rendererObjects[0]!,
        subjectKey: 'fixture.mesh.secondary',
    })
    const initial = createInitialLabExplorerReviews(session)
    const reviews = {
        ...initial,
        'edge-click': { ...initial['edge-click']!, decision: 'approved' as const },
        'edge-renderer': { ...initial['edge-renderer']!, decision: 'approved' as const },
    }
    const readiness = labExplorerRouteReadiness(session, 'route-1', reviews)
    assert.equal(readiness.ready, false)
    assert.ok(readiness.errors.some(error => error.includes('HTTP(S)')))
    assert.ok(readiness.errors.some(error => error.includes('动作时长')))
    assert.ok(readiness.errors.some(error => error.includes('多个 renderer object')))
})
