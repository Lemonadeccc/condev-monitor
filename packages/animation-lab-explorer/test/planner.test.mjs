import assert from 'node:assert/strict'
import test from 'node:test'

import { planAnimationLabExploration, resolveExplorerPlanningPolicy } from '../build/esm/index.js'

function candidate(overrides = {}) {
    return {
        candidateId: 'candidate-one',
        kind: 'click',
        originRelation: 'same-origin',
        depth: 2,
        estimatedDurationMs: 250,
        intent: 'ordinary',
        localOnly: { selector: '[data-lab="candidate-one"]', textHint: 'Open details' },
        ...overrides,
    }
}

test('proposes all supported candidate kinds as local actions that still require review', () => {
    const proposal = planAnimationLabExploration({
        pageKey: 'fixture-home',
        routeKey: 'fixture.home',
        candidates: [
            candidate({ candidateId: 'safe-click' }),
            candidate({ candidateId: 'safe-hover', kind: 'hover', estimatedDurationMs: 400 }),
            candidate({
                candidateId: 'safe-scroll',
                kind: 'scroll',
                estimatedDurationMs: 800,
                localOnly: { scrollDeltaY: 900 },
            }),
            candidate({
                candidateId: 'safe-pointer',
                kind: 'pointer-path',
                estimatedDurationMs: 900,
                localOnly: {
                    pointerPath: [
                        { xRatio: 0.2, yRatio: 0.3 },
                        { xRatio: 0.8, yRatio: 0.7 },
                    ],
                },
            }),
        ],
    })

    assert.equal(proposal.dataClassification, 'local-only')
    assert.equal(proposal.status, 'needs-review')
    assert.deepEqual(
        proposal.actions.map(action => action.kind),
        ['click', 'hover', 'scroll', 'pointer-path']
    )
    assert.equal(
        proposal.actions.every(action => action.manualReviewRequired),
        true
    )
    assert.equal(proposal.actions[0].selector, '[data-lab="candidate-one"]')
    assert.equal(proposal.actions[2].deltaY, 900)
    assert.equal(proposal.actions[3].points.length, 2)
    assert.equal(proposal.coverage.complete, false)
    assert.match(proposal.coverage.warning, /never represents complete or 100%/u)
})

test('samples candidate kinds fairly when early DOM order contains many clicks', () => {
    const proposal = planAnimationLabExploration(
        {
            pageKey: 'fair-trigger-page',
            candidates: [
                ...Array.from({ length: 20 }, (_, index) =>
                    candidate({
                        candidateId: `click-${index}`,
                        localOnly: { selector: `[data-click="${index}"]` },
                    })
                ),
                candidate({ candidateId: 'tail-hover', kind: 'hover', estimatedDurationMs: 400 }),
                candidate({
                    candidateId: 'tail-scroll',
                    kind: 'scroll',
                    estimatedDurationMs: 800,
                    localOnly: { scrollDeltaY: 900 },
                }),
                candidate({
                    candidateId: 'tail-pointer',
                    kind: 'pointer-path',
                    estimatedDurationMs: 900,
                    localOnly: {
                        pointerPath: [
                            { xRatio: 0.2, yRatio: 0.3 },
                            { xRatio: 0.8, yRatio: 0.7 },
                        ],
                    },
                }),
            ],
        },
        { maxActions: 4 }
    )

    assert.deepEqual(
        proposal.actions.map(action => action.kind),
        ['click', 'hover', 'scroll', 'pointer-path']
    )
})

test('rejects dangerous and non-same-origin candidates by default', () => {
    const dangerousIntents = ['submit', 'delete', 'payment', 'logout', 'file', 'password', 'unknown']
    const candidates = dangerousIntents.map((intent, index) =>
        candidate({ candidateId: `risk-${index + 1}`, intent, localOnly: { selector: `[data-risk="${index + 1}"]` } })
    )
    candidates.push(
        candidate({ candidateId: 'hint-risk', intent: 'ordinary', localOnly: { selector: '#safe-looking', textHint: 'Pay now' } })
    )
    candidates.push(candidate({ candidateId: 'foreign', originRelation: 'cross-origin' }))
    candidates.push(candidate({ candidateId: 'origin-unknown', originRelation: 'unknown' }))

    const proposal = planAnimationLabExploration({ pageKey: 'fixture', candidates })

    assert.equal(proposal.actions.length, 0)
    assert.equal(proposal.excludedCandidates.filter(value => value.reason === 'dangerous-action').length, 8)
    assert.equal(
        proposal.excludedCandidates.some(value => value.reason === 'cross-origin'),
        true
    )
    assert.equal(
        proposal.excludedCandidates.some(value => value.reason === 'unknown-origin'),
        true
    )
    assert.equal(
        proposal.excludedCandidates.every(value => value.disposition === 'reject'),
        true
    )
})

test('enforces candidate, action, depth, per-action, and total-duration bounds without a completeness claim', () => {
    const proposal = planAnimationLabExploration(
        {
            pageKey: 'bounded-page',
            candidates: [
                candidate({ candidateId: 'accepted', estimatedDurationMs: 400 }),
                candidate({ candidateId: 'too-deep', depth: 4 }),
                candidate({ candidateId: 'too-long', estimatedDurationMs: 900 }),
                candidate({ candidateId: 'unexamined-one' }),
                candidate({ candidateId: 'unexamined-two' }),
            ],
        },
        { maxCandidates: 3, maxActions: 2, maxDepth: 3, maxActionDurationMs: 800, maxTotalDurationMs: 700 }
    )

    assert.deepEqual(
        proposal.actions.map(action => action.candidateId),
        ['accepted']
    )
    assert.equal(
        proposal.excludedCandidates.some(value => value.reason === 'depth-limit'),
        true
    )
    assert.equal(
        proposal.excludedCandidates.some(value => value.reason === 'invalid-duration'),
        true
    )
    assert.equal(proposal.coverage.examinedCandidates, 3)
    assert.equal(proposal.coverage.unexaminedCandidates, 2)
    assert.equal(proposal.coverage.complete, false)

    const totalBound = planAnimationLabExploration(
        {
            pageKey: 'duration-page',
            candidates: [
                candidate({ candidateId: 'first', estimatedDurationMs: 400 }),
                candidate({ candidateId: 'second', estimatedDurationMs: 400 }),
            ],
        },
        { maxTotalDurationMs: 700 }
    )
    assert.equal(totalBound.excludedCandidates[0].reason, 'total-duration-limit')

    const actionBound = planAnimationLabExploration(
        { pageKey: 'action-page', candidates: [candidate({ candidateId: 'first' }), candidate({ candidateId: 'second' })] },
        { maxActions: 1 }
    )
    assert.equal(actionBound.excludedCandidates[0].reason, 'action-limit')
})

test('quarantine is review isolation rather than permission to execute dangerous actions', () => {
    const proposal = planAnimationLabExploration(
        {
            pageKey: 'quarantine-page',
            candidates: [
                candidate({ candidateId: 'delete-control', intent: 'delete', localOnly: { selector: '#delete-account' } }),
                candidate({ candidateId: 'foreign-control', originRelation: 'cross-origin' }),
            ],
        },
        { dangerousActionDisposition: 'quarantine', crossOriginDisposition: 'quarantine' }
    )

    assert.equal(proposal.actions.length, 0)
    assert.equal(
        proposal.excludedCandidates.every(value => value.disposition === 'quarantine'),
        true
    )
    assert.equal(proposal.coverage.quarantinedCandidates, 2)
})

test('rejects malformed local targeting details instead of silently widening the target', () => {
    const proposal = planAnimationLabExploration({
        pageKey: 'invalid-local-data',
        candidates: [
            candidate({ candidateId: 'missing-selector', localOnly: {} }),
            candidate({ candidateId: 'invalid-selector', localOnly: { selector: `#bad\u0000selector` } }),
            candidate({ candidateId: 'invalid-scroll', kind: 'scroll', localOnly: { scrollDeltaY: 0 } }),
            candidate({
                candidateId: 'invalid-pointer',
                kind: 'pointer-path',
                localOnly: { pointerPath: [{ xRatio: 2, yRatio: 0.5 }] },
            }),
        ],
    })

    assert.deepEqual(
        proposal.excludedCandidates.map(value => value.reason).sort(),
        ['missing-selector', 'invalid-selector', 'invalid-scroll-delta', 'invalid-pointer-path'].sort()
    )
})

test('validates policy bounds and supported kinds', () => {
    assert.throws(() => resolveExplorerPlanningPolicy({ maxActions: 0 }), /maxActions/u)
    assert.throws(() => resolveExplorerPlanningPolicy({ allowedKinds: ['press'] }), /allowedKinds/u)
    assert.throws(() => resolveExplorerPlanningPolicy({ dangerousActionDisposition: 'allow' }), /dangerousActionDisposition/u)
})
