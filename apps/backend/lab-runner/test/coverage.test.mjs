import assert from 'node:assert/strict'
import test from 'node:test'

import { coverageResultsFromAttempts, createLocalScenarioSha256, validateCoverageManifestForScenario } from '../build/index.js'

function scenario() {
    return {
        schemaVersion: 1,
        name: 'coverage-fixture',
        url: 'http://127.0.0.1:43105/',
        routeKey: 'coverage.fixture',
        viewport: { width: 1280, height: 720 },
        warmupRuns: 0,
        measuredRuns: 2,
        actions: [
            {
                kind: 'pointer-path',
                label: 'hero-object-hit',
                actionId: 'hero-object-hit',
                selector: 'canvas',
                durationMs: 100,
                points: [
                    { xRatio: 0.25, yRatio: 0.5 },
                    { xRatio: 0.75, yRatio: 0.5 },
                ],
                expect: [
                    {
                        kind: 'registered-outcome',
                        outcomeKey: 'hero.object.hit',
                        state: 'completed',
                        timeoutMs: 1_000,
                    },
                ],
            },
        ],
    }
}

function manifest(reviewed = scenario()) {
    return {
        schemaVersion: 1,
        routeKey: reviewed.routeKey,
        reviewStatus: 'reviewed',
        localScenarioSha256: createLocalScenarioSha256(reviewed),
        items: [
            {
                coverageId: 'hero.critical-object',
                kind: 'renderer-object',
                actionId: 'hero-object-hit',
                origin: 'explorer',
                critical: true,
                authentication: 'none',
                outcomeContract: { kind: 'registered-outcome', outcomeKey: 'hero.object.hit' },
                hit: {
                    kind: 'renderer-adapter',
                    adapterKey: 'three.raycast',
                    objectKey: 'hero.primary',
                    strategy: 'raycast',
                },
            },
        ],
    }
}

function measuredAttempt(index, outcome, limitations = []) {
    return {
        attemptId: `attempt-${index}`,
        phase: 'measured',
        index,
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [],
        capabilities: {},
        limitations: [],
        actionWindows: [
            {
                actionId: 'hero-object-hit',
                order: 0,
                kind: 'pointer-path',
                trigger: { source: 'scenario' },
                outcome: { status: outcome },
                timestamps: { clock: 'attempt-monotonic', startedAtMs: 0, endedAtMs: 100, durationMs: 100 },
                evidenceRefs: ['runner-action-clock'],
                limitations,
            },
        ],
    }
}

test('binds the local coverage denominator to the complete Scenario including selectors and outcome keys', () => {
    const reviewed = scenario()
    assert.deepEqual(validateCoverageManifestForScenario(manifest(reviewed), reviewed).items.length, 1)

    const selectorDrift = structuredClone(reviewed)
    selectorDrift.actions[0].selector = '#different-canvas'
    assert.throws(() => validateCoverageManifestForScenario(manifest(reviewed), selectorDrift), /complete reviewed Scenario/u)

    const outcomeDrift = structuredClone(reviewed)
    outcomeDrift.actions[0].expect[0].outcomeKey = 'different.object.hit'
    assert.throws(() => validateCoverageManifestForScenario(manifest(reviewed), outcomeDrift), /complete reviewed Scenario/u)

    const incompleteInventory = structuredClone(reviewed)
    incompleteInventory.actions.push({
        kind: 'resize',
        label: 'responsive-layout',
        actionId: 'responsive-layout',
        width: 1024,
        height: 768,
    })
    assert.throws(
        () => validateCoverageManifestForScenario(manifest(incompleteInventory), incompleteInventory),
        /every reviewed Scenario action/u
    )
})

test('classifies renderer-object coverage across every measured attempt', () => {
    const reviewed = scenario()
    const input = manifest(reviewed)
    assert.deepEqual(
        coverageResultsFromAttempts({
            manifest: input,
            scenario: reviewed,
            attempts: [measuredAttempt(0, 'completed'), measuredAttempt(1, 'completed')],
            authenticated: false,
        }),
        [{ coverageId: 'hero.critical-object', status: 'passed', reasons: [] }]
    )

    assert.deepEqual(
        coverageResultsFromAttempts({
            manifest: input,
            scenario: reviewed,
            attempts: [measuredAttempt(0, 'failed', ['outcome-assertion-failed']), measuredAttempt(1, 'completed')],
            authenticated: false,
        }),
        [
            {
                coverageId: 'hero.critical-object',
                status: 'failed',
                reasons: ['action-failed', 'outcome-not-observed', 'renderer-object-not-resolved'],
            },
        ]
    )

    for (const [outcome, limitations, reasons] of [
        ['cancelled', [], ['action-failed', 'outcome-not-observed', 'renderer-object-not-resolved']],
        ['timed-out', ['action-timeout'], ['action-failed', 'outcome-not-observed', 'action-timed-out', 'renderer-object-not-resolved']],
        ['unknown', [], ['action-failed', 'outcome-not-observed', 'renderer-object-not-resolved']],
    ]) {
        assert.deepEqual(
            coverageResultsFromAttempts({
                manifest: input,
                scenario: reviewed,
                attempts: [measuredAttempt(0, outcome, limitations), measuredAttempt(1, 'completed')],
                authenticated: false,
            }),
            [{ coverageId: 'hero.critical-object', status: 'failed', reasons }]
        )
    }
})

test('allows non-critical inventory actions to rely on runner completion without a business outcome gate', () => {
    const reviewed = scenario()
    reviewed.actions.push({
        kind: 'resize',
        label: 'responsive-layout',
        actionId: 'responsive-layout',
        width: 1024,
        height: 768,
    })
    const input = manifest(reviewed)
    input.items.push({
        coverageId: 'hero.responsive-layout',
        kind: 'resize',
        actionId: 'responsive-layout',
        origin: 'declared',
        critical: false,
        authentication: 'none',
    })
    const secondWindow = structuredClone(measuredAttempt(0, 'completed').actionWindows[0])
    secondWindow.actionId = 'responsive-layout'
    secondWindow.kind = 'resize'
    const attempts = [measuredAttempt(0, 'completed'), measuredAttempt(1, 'completed')]
    attempts.forEach(attempt => attempt.actionWindows.push(structuredClone(secondWindow)))

    assert.deepEqual(validateCoverageManifestForScenario(input, reviewed).items.length, 2)
    assert.deepEqual(coverageResultsFromAttempts({ manifest: input, scenario: reviewed, attempts, authenticated: false }), [
        { coverageId: 'hero.critical-object', status: 'passed', reasons: [] },
        { coverageId: 'hero.responsive-layout', status: 'passed', reasons: [] },
    ])
})

test('keeps missing authentication and partial measured-attempt coverage explicit', () => {
    const reviewed = scenario()
    const input = manifest(reviewed)
    input.items[0].authentication = 'required-local-storage-state'
    assert.deepEqual(
        coverageResultsFromAttempts({
            manifest: input,
            scenario: reviewed,
            attempts: [measuredAttempt(0, 'completed'), measuredAttempt(1, 'completed')],
            authenticated: false,
        }),
        [{ coverageId: 'hero.critical-object', status: 'not-executed', reasons: ['authentication-required'] }]
    )

    input.items[0].authentication = 'none'
    assert.deepEqual(
        coverageResultsFromAttempts({
            manifest: input,
            scenario: reviewed,
            attempts: [measuredAttempt(0, 'completed')],
            authenticated: true,
        }),
        [{ coverageId: 'hero.critical-object', status: 'failed', reasons: ['partial-attempt-coverage'] }]
    )
})
