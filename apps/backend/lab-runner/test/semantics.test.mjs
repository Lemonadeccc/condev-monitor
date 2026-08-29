import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    ANIMATION_LAB_METRIC_CATALOG_V3,
    ANIMATION_LAB_METRIC_CATALOG_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V3,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V5,
    DEFAULT_ANIMATION_LAB_BUDGET_V2,
    evaluateAnimationLabBudgetRule,
    validateAnimationLabSemanticsV2,
} from '@condev-monitor/animation-lab'

import {
    actionWindowFromProbe,
    aggregateMeasuredAttempts,
    buildAnimationLabSemantics,
    decorateLabMetric,
    decorateLighthouseLabMetric,
    projectDiagnosticAttemptMetrics,
    projectAttemptsForReport,
} from '../build/index.js'

const scenario = {
    schemaVersion: 1,
    name: 'semantic-fixture',
    url: 'http://localhost:5173/',
    routeKey: 'semantic.fixture',
    viewport: { width: 1280, height: 720 },
    warmupRuns: 0,
    measuredRuns: 3,
    actions: [
        {
            kind: 'hover',
            label: 'hero-hover',
            actionId: 'hero-hover',
            selector: '[data-lab="hero"]',
            durationMs: 500,
            subject: { scope: 'renderer-surface', subjectKey: 'hero-surface', role: 'hero', surface: 'webgl' },
            technologies: [
                { axis: 'ui-framework', technologyKey: 'react', version: '19' },
                { axis: 'renderer', technologyKey: 'three' },
            ],
        },
    ],
}

function frameMetric(value, samples = 120) {
    return {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value,
        samples,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    }
}

function longTaskMetric(value, samples = value, status = 'measured') {
    return {
        family: 'mainThread',
        name: 'longTaskCount',
        stat: 'count',
        unit: 'count',
        value,
        samples,
        status,
        evidenceLevel: 'controlled-lab-measurement',
    }
}

test('creates selector-free action semantics and across-attempt metrics', () => {
    const attempts = [28, 30, 32].map((value, index) => {
        const attemptId = `attempt-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: `2026-08-26T00:00:0${index}.000Z`,
            endedAt: `2026-08-26T00:00:0${index + 1}.000Z`,
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(frameMetric(value), { level: 'attempt', attemptId }),
                decorateLabMetric(frameMetric(value, 40), { level: 'action', attemptId, actionId: 'hero-hover' }),
            ],
            actionWindows: [
                actionWindowFromProbe(scenario.actions[0], 0, {
                    startedAtMs: 100 + index,
                    endedAtMs: 600 + index,
                    outcome: 'completed',
                }),
            ],
            capabilities: { longtask: true },
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
    assert.equal(semantics.actionWindows.length, 1)
    assert.equal(semantics.actionWindows[0].timestamps.durationMs, 500)
    assert.equal(semantics.metrics.find(metric => metric.scope.actionId === 'hero-hover').scope.attemptId, undefined)
    assert.equal(semantics.metrics.find(metric => metric.scope.actionId === 'hero-hover').samples, 120)
    assert.ok(semantics.technologyEvidence.some(item => item.technologyKey === 'webgl' && item.status === 'declared'))
    assert.ok(
        semantics.technologyEvidence.some(
            item =>
                item.technologyKey === 'react' &&
                item.axis === 'ui-framework' &&
                item.status === 'declared' &&
                item.scope.actionId === 'hero-hover'
        )
    )
    assert.ok(
        semantics.technologyEvidence.some(
            item => item.technologyKey === 'three' && item.limitations.includes('declared-technology-is-not-runtime-owner-proof')
        )
    )
    assert.ok(semantics.technologyEvidence.some(item => item.technologyKey === 'condev-runner-monotonic-clock'))
    assert.equal(
        semantics.technologyEvidence.some(item => item.technologyKey === 'playwright-runner-clock'),
        false
    )
    assert.ok(semantics.findings.some(item => item.ruleId === 'frame-tail' && item.actionIds.includes('hero-hover')))
    assert.equal(JSON.stringify(semantics).includes('[data-lab'), false)
})

test('keeps decoration on budget v1 unless a known newer reference is explicit', () => {
    const base = decorateLabMetric(longTaskMetric(0, 0), { level: 'run' }, { acrossAttempts: true })
    assert.deepEqual(base.budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V1, ruleId: 'long-task-count' }])

    const optedIn = decorateLabMetric(
        longTaskMetric(0, 0),
        { level: 'run' },
        { acrossAttempts: true, budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2 }
    )
    assert.deepEqual(optedIn.budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'long-task-count' }])

    const expanded = decorateLabMetric(
        {
            family: 'userOutcome',
            name: 'processingDurationMs',
            stat: 'p95',
            unit: 'ms',
            value: 55,
            samples: 3,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
        },
        { level: 'run' },
        { acrossAttempts: true, budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V3 }
    )
    assert.deepEqual(expanded.budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V3, ruleId: 'interaction-processing-tail' }])

    const loaf = decorateLabMetric(
        {
            family: 'mainThread',
            name: 'longAnimationFrameCount',
            stat: 'count',
            unit: 'count',
            value: 0,
            samples: 0,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
        },
        { level: 'run' },
        { acrossAttempts: true, budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V3 }
    )
    assert.deepEqual(loaf.budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V3, ruleId: 'loaf-count' }])

    const mediaCatalogBudget = decorateLabMetric(
        longTaskMetric(0, 0),
        { level: 'run' },
        { acrossAttempts: true, budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V5 }
    )
    assert.deepEqual(mediaCatalogBudget.budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V5, ruleId: 'long-task-count' }])

    const unknown = decorateLabMetric(
        longTaskMetric(0, 0),
        { level: 'run' },
        {
            acrossAttempts: true,
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 6 },
        }
    )
    assert.deepEqual(unknown.budgetRefs, [])
})

test('promotes isolated diagnostic metrics into canonical run scope for v3 findings', () => {
    const lighthouseMetric = decorateLighthouseLabMetric(
        {
            family: 'lighthouse',
            name: 'FCP',
            stat: 'latest',
            unit: 'ms',
            value: 2_000,
            samples: 1,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            limitations: ['separate-navigation-experiment'],
        },
        'lighthouse-attempt',
        DEFAULT_ANIMATION_LAB_BUDGET_REF_V3,
        'desktop'
    )
    const attempts = [
        {
            attemptId: 'lighthouse-attempt',
            phase: 'lighthouse',
            index: 0,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [lighthouseMetric],
            capabilities: { lighthouse: true },
            limitations: [],
        },
    ]
    const projected = projectDiagnosticAttemptMetrics(attempts)
    assert.deepEqual(projected[0].scope, { level: 'run' })
    assert.deepEqual(projected[0].aggregation, { population: 'latest', method: 'latest' })
    assert.deepEqual(projected[0].budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V3, ruleId: 'lighthouse-first-contentful-paint' }])
    assert.deepEqual(projected[0].limitations, [
        'separate-navigation-experiment',
        'lighthouse-form-factor-desktop',
        'lighthouse-isolated-process-does-not-inherit-measured-cache',
    ])

    const semantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V3,
                metricCatalogVersion: 2,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics: projected,
    })
    assert.equal(semantics.findings[0].ruleId, 'lighthouse-first-contentful-paint')
    assert.equal(semantics.findings[0].status, 'observed')
    assert.ok(semantics.findings[0].limitations.includes('separate-navigation-experiment'))
    assert.ok(semantics.findings[0].limitations.includes('lighthouse-form-factor-desktop'))
    assert.ok(semantics.findings[0].limitations.includes('lighthouse-isolated-process-does-not-inherit-measured-cache'))
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('fails closed when diagnostic attempts repeat one closed metric identity', () => {
    const diagnostic = phase => ({
        attemptId: `${phase}-attempt`,
        phase,
        index: 0,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [
            decorateLabMetric(
                {
                    family: 'lighthouse',
                    name: 'FCP',
                    stat: 'latest',
                    unit: 'ms',
                    value: 1_000,
                    samples: 1,
                    status: 'measured',
                    evidenceLevel: 'controlled-lab-measurement',
                },
                { level: 'attempt', attemptId: `${phase}-attempt` },
                { evidenceId: 'lighthouse', budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V3 }
            ),
        ],
        capabilities: {},
        limitations: [],
    })
    assert.throws(
        () => projectDiagnosticAttemptMetrics([diagnostic('lighthouse'), diagnostic('diagnostic-trace')]),
        /Duplicate diagnostic/u
    )
})

test('treats three complete zero-event Long Task attempts as measured only under budget v2', () => {
    const v2Scenario = {
        ...scenario,
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
            metricCatalogVersion: 2,
        },
    }
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `zero-long-task-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    longTaskMetric(0, 0),
                    { level: 'attempt', attemptId },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2 }
                ),
            ],
            capabilities: { longtask: true },
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario: v2Scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.deepEqual(
        aggregateMetrics.map(metric => ({ value: metric.value, samples: metric.samples, status: metric.status })),
        [{ value: 0, samples: 0, status: 'measured' }]
    )
    assert.deepEqual(semantics.metrics[0].budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'long-task-count' }])
    assert.equal(semantics.findings.length, 0)
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('does not treat a median-zero Long Task aggregate with observed events as healthy', () => {
    const attempts = [0, 0, 1].map((value, index) => {
        const attemptId = `mixed-long-task-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    longTaskMetric(value),
                    { level: 'attempt', attemptId },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2 }
                ),
            ],
            capabilities: { longtask: true },
            limitations: [],
        }
    })
    const [aggregate] = aggregateMeasuredAttempts(attempts)
    const rule = DEFAULT_ANIMATION_LAB_BUDGET_V2.rules.find(item => item.ruleId === 'long-task-count')

    assert.deepEqual(
        { value: aggregate.value, samples: aggregate.samples, status: aggregate.status },
        { value: 0, samples: 1, status: 'measured' }
    )
    assert.equal(evaluateAnimationLabBudgetRule(rule, aggregate, { targetFrameMs: 16.666667 }).status, 'insufficient-evidence')
})

test('emits observed and candidate Long Task findings from the selected budget v2', () => {
    const v2Scenario = {
        ...scenario,
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2,
            metricCatalogVersion: 2,
        },
    }
    const build = metric =>
        buildAnimationLabSemantics({
            scenario: v2Scenario,
            browser: { name: 'chromium', version: '140.0.0' },
            attempts: [],
            aggregateMetrics: [
                decorateLabMetric(metric, { level: 'run' }, { acrossAttempts: true, budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V2 }),
            ],
        })

    const observed = build(longTaskMetric(1, 3))
    assert.equal(observed.findings[0].status, 'observed')
    assert.equal(observed.findings[0].ruleId, 'long-task-count')
    assert.deepEqual(observed.findings[0].budgetRefs, [{ ...DEFAULT_ANIMATION_LAB_BUDGET_REF_V2, ruleId: 'long-task-count' }])

    const candidate = build(longTaskMetric(1, 1, 'partial'))
    assert.equal(candidate.findings[0].status, 'candidate')
    assert.equal(build(longTaskMetric(0, 0, 'partial')).findings.length, 0)
    assert.equal(build({ ...longTaskMetric(0, 0), samples: null }).findings.length, 0)
})

test('preserves unsupported metrics instead of turning them into zero', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => ({
        attemptId: `attempt-${index}`,
        phase: 'measured',
        index,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [
            decorateLabMetric(
                { ...frameMetric(0, 0), value: null, samples: null, status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' },
                { level: 'attempt', attemptId: `attempt-${index}` }
            ),
        ],
        capabilities: {},
        limitations: [],
    }))
    const [metric] = aggregateMeasuredAttempts(attempts)
    assert.equal(metric.value, null)
    assert.equal(metric.status, 'unsupported')
    assert.equal(metric.evidenceLevel, 'unsupported-or-unknown')
    assert.equal(metric.samples, 0)
})

test('keeps mixed unsupported and unknown availability unknown across attempts', () => {
    const attempts = ['unsupported', 'unknown', 'unsupported'].map((status, index) => ({
        attemptId: `attempt-${index}`,
        phase: 'measured',
        index,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [
            decorateLabMetric(
                { ...frameMetric(0, 0), value: null, samples: null, status, evidenceLevel: 'unsupported-or-unknown' },
                { level: 'attempt', attemptId: `attempt-${index}` }
            ),
        ],
        capabilities: {},
        limitations: [],
    }))
    const [metric] = aggregateMeasuredAttempts(attempts)
    assert.equal(metric.value, null)
    assert.equal(metric.status, 'unknown')
    assert.equal(metric.evidenceLevel, 'unsupported-or-unknown')
    assert.equal(metric.samples, 0)
})

test('normalizes unavailable aggregate evidence for unsupported/not-observed mixtures and all-unknown attempts', () => {
    for (const statuses of [
        ['unsupported', 'not-observed', 'unsupported'],
        ['unknown', 'unknown', 'unknown'],
    ]) {
        const attempts = statuses.map((status, index) => ({
            attemptId: `unavailable-${index}`,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    {
                        ...frameMetric(0, 0),
                        value: null,
                        samples: status === 'not-observed' ? 0 : null,
                        status,
                        evidenceLevel: status === 'not-observed' ? 'controlled-lab-measurement' : 'unsupported-or-unknown',
                    },
                    { level: 'attempt', attemptId: `unavailable-${index}` }
                ),
            ],
            capabilities: {},
            limitations: [],
        }))
        const [metric] = aggregateMeasuredAttempts(attempts)
        assert.equal(metric.value, null)
        assert.equal(metric.status, 'unknown')
        assert.equal(metric.evidenceLevel, 'unsupported-or-unknown')
    }

    const notObservedAttempts = Array.from({ length: 3 }, (_, index) => ({
        attemptId: `not-observed-${index}`,
        phase: 'measured',
        index,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [
            decorateLabMetric(
                {
                    ...frameMetric(0, 0),
                    value: null,
                    samples: 0,
                    status: 'not-observed',
                    evidenceLevel: 'controlled-lab-measurement',
                },
                { level: 'attempt', attemptId: `not-observed-${index}` }
            ),
        ],
        capabilities: {},
        limitations: [],
    }))
    const [notObserved] = aggregateMeasuredAttempts(notObservedAttempts)
    assert.equal(notObserved.status, 'not-observed')
    assert.equal(notObserved.evidenceLevel, 'controlled-lab-measurement')
})

test('uses available measured evidence when a partial aggregate begins with an unsupported attempt', () => {
    const statuses = ['unsupported', 'measured', 'measured']
    const attempts = statuses.map((status, index) => ({
        attemptId: `partial-evidence-${index}`,
        phase: 'measured',
        index,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [
            decorateLabMetric(
                {
                    ...frameMetric(index + 10),
                    value: status === 'measured' ? index + 10 : null,
                    samples: status === 'measured' ? 40 : null,
                    status,
                    evidenceLevel: status === 'measured' ? 'controlled-lab-measurement' : 'unsupported-or-unknown',
                },
                { level: 'attempt', attemptId: `partial-evidence-${index}` }
            ),
        ],
        capabilities: {},
        limitations: [],
    }))
    const [metric] = aggregateMeasuredAttempts(attempts)
    assert.equal(metric.status, 'partial')
    assert.equal(metric.evidenceLevel, 'controlled-lab-measurement')
})

test('uses producer metricId to disambiguate the Lighthouse CLS tuple', () => {
    const metric = decorateLabMetric(
        {
            family: 'userOutcome',
            name: 'CLS',
            stat: 'latest',
            unit: 'score',
            value: 0.1,
            samples: 1,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            metricId: 'lighthouse.cls.latest',
        },
        { level: 'attempt', attemptId: 'lighthouse-attempt' },
        { evidenceId: 'lighthouse' }
    )
    assert.equal(metric.metricId, 'lighthouse.cls.latest')
})

test('decorates and validates every new opt-in catalog v2 scheduling and LoAF diagnostic metric', () => {
    const metricIds = [
        'main.input-capture-to-next-raf-callback.count',
        'main.input-capture-to-next-raf-callback.p95',
        'interaction.loaf-first-ui-event-to-frame-end.count',
        'interaction.loaf-first-ui-event-to-frame-end.p95',
        'pipeline.loaf-attributed-forced-style-layout.count',
        'pipeline.loaf-attributed-forced-style-layout.p95',
    ]
    const metrics = metricIds.map(metricId => {
        const entry = ANIMATION_LAB_METRIC_CATALOG_V2.find(item => item.metricId === metricId)
        return decorateLabMetric(
            {
                family: entry.family,
                name: entry.name,
                stat: entry.stat,
                unit: entry.unit,
                value: entry.stat === 'count' ? 3 : 24,
                samples: 3,
                status: 'measured',
                evidenceLevel: 'controlled-lab-measurement',
                limitations: ['diagnostic-proxy'],
            },
            { level: 'run' },
            { acrossAttempts: true }
        )
    })
    const semantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
                metricCatalogVersion: 2,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts: [],
        aggregateMetrics: metrics,
    })

    assert.deepEqual(
        metrics.map(metric => metric.metricId),
        metricIds
    )
    assert.equal(semantics.measurementContract.metricCatalogVersion, 2)
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('aggregates catalog v3 action-window video deltas without changing the cumulative video metric', () => {
    const entry = ANIMATION_LAB_METRIC_CATALOG_V3.find(item => item.metricId === 'media.video-window-dropped-frame-rate')
    const limitations = [
        'video-playback-quality-window-counter-delta',
        'video-playback-quality-total-includes-displayed-and-dropped',
        'video-playback-quality-window-object-identity-only',
        'video-playback-quality-not-decode-presentation-or-gpu-timing',
    ]
    const attempts = [0, 0.03, 0.06].map((value, index) => {
        const attemptId = `video-window-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: `2026-08-27T00:00:0${index}.000Z`,
            endedAt: `2026-08-27T00:00:0${index + 1}.000Z`,
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    {
                        family: entry.family,
                        name: entry.name,
                        stat: entry.stat,
                        unit: entry.unit,
                        value,
                        samples: 100,
                        status: 'measured',
                        evidenceLevel: 'controlled-lab-measurement',
                        limitations,
                    },
                    { level: 'action', attemptId, actionId: 'hero-hover' }
                ),
            ],
            actionWindows: [
                actionWindowFromProbe(scenario.actions[0], 0, {
                    startedAtMs: 100,
                    endedAtMs: 600,
                    outcome: 'completed',
                }),
            ],
            capabilities: { videoPlaybackQuality: true },
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    assert.deepEqual(
        aggregateMetrics.map(metric => ({
            metricId: metric.metricId,
            value: metric.value,
            samples: metric.samples,
            status: metric.status,
        })),
        [{ metricId: 'media.video-window-dropped-frame-rate', value: 0.03, samples: 300, status: 'measured' }]
    )

    const semantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
                metricCatalogVersion: 3,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
    assert.equal(semantics.metrics[0].scope.level, 'action')

    const overflowAttempts = attempts.map(attempt => ({
        ...attempt,
        metrics: attempt.metrics.map(metric => ({ ...metric, samples: 4_000_000 })),
    }))
    const overflowAggregateMetrics = aggregateMeasuredAttempts(overflowAttempts)
    const overflowSemantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
                metricCatalogVersion: 3,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts: overflowAttempts,
        aggregateMetrics: overflowAggregateMetrics,
    })
    assert.deepEqual(
        overflowAggregateMetrics.map(metric => ({
            metricId: metric.metricId,
            value: metric.value,
            samples: metric.samples,
            status: metric.status,
        })),
        [{ metricId: 'media.video-window-dropped-frame-rate', value: 0.03, samples: null, status: 'partial' }]
    )
    assert.ok(overflowAggregateMetrics[0].limitations.includes('aggregate-sample-count-exceeds-contract-bound'))
    assert.equal(validateAnimationLabSemanticsV2(overflowSemantics).ok, true)
})

test('aggregates catalog v4 renderer evidence while keeping GPU page-scoped', () => {
    const metric = (name, value, samples = 40) => ({
        family: 'renderer',
        name,
        stat: 'p95',
        unit: name === 'gpuFrameMs' ? 'ms' : 'count',
        value,
        samples,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        limitations: [],
    })
    const attempts = [14, 15, 16].map((gpuValue, index) => {
        const attemptId = `renderer-attempt-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: `2026-08-26T00:00:0${index}.000Z`,
            endedAt: `2026-08-26T00:00:0${index + 1}.000Z`,
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    metric('drawCalls', 100 + index),
                    { level: 'attempt', attemptId },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4 }
                ),
                decorateLabMetric(
                    metric('triangles', 10_000 + index),
                    { level: 'attempt', attemptId },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4 }
                ),
                decorateLabMetric(
                    metric('gpuFrameMs', gpuValue),
                    { level: 'attempt', attemptId },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4 }
                ),
                decorateLabMetric(
                    metric('drawCalls', 50 + index),
                    { level: 'action', attemptId, actionId: 'hero-hover' },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4 }
                ),
                decorateLabMetric(
                    metric('triangles', 5_000 + index),
                    { level: 'action', attemptId, actionId: 'hero-hover' },
                    { budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4 }
                ),
            ],
            actionWindows: [
                actionWindowFromProbe(scenario.actions[0], 0, {
                    startedAtMs: 100,
                    endedAtMs: 600,
                    outcome: 'completed',
                }),
            ],
            capabilities: { rendererEvidenceBridge: true },
            limitations: ['renderer-gpu-action-window-not-proven'],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const gpu = aggregateMetrics.find(item => item.metricId === 'renderer.gpu-frame.p95')
    const actionDraw = aggregateMetrics.find(item => item.metricId === 'renderer.draw-calls.p95' && item.scope.actionId === 'hero-hover')
    assert.deepEqual(
        { value: gpu.value, samples: gpu.samples, status: gpu.status, scope: gpu.scope.level },
        {
            value: 15,
            samples: 120,
            status: 'measured',
            scope: 'run',
        }
    )
    assert.deepEqual(
        { value: actionDraw.value, samples: actionDraw.samples, scope: actionDraw.scope },
        {
            value: 51,
            samples: 120,
            scope: { level: 'action', actionId: 'hero-hover' },
        }
    )
    assert.equal(
        aggregateMetrics.some(item => item.metricId === 'renderer.gpu-frame.p95' && item.scope.actionId === 'hero-hover'),
        false
    )

    const semantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
                metricCatalogVersion: 4,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
    assert.ok(semantics.findings.some(item => item.ruleId === 'renderer-gpu-frame-tail' && item.status === 'observed'))

    const truncatedAggregateMetrics = aggregateMetrics.map(item =>
        item.metricId === 'renderer.gpu-frame.p95'
            ? {
                  ...item,
                  status: 'partial',
                  limitations: [...item.limitations, 'page-probe-renderer-host-evidence-truncated'],
              }
            : item
    )
    const truncatedSemantics = buildAnimationLabSemantics({
        scenario: {
            ...scenario,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
                metricCatalogVersion: 4,
            },
        },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics: truncatedAggregateMetrics,
    })
    const truncatedFinding = truncatedSemantics.findings.find(item => item.ruleId === 'renderer-gpu-frame-tail')
    assert.equal(truncatedFinding.status, 'candidate')
    assert.ok(truncatedFinding.limitations.includes('page-probe-renderer-host-evidence-truncated'))
})

test('keeps canonical analysis valid for the maximum action count by projecting metrics deterministically', () => {
    const actions = Array.from({ length: 100 }, (_, index) => ({
        kind: 'hover',
        label: `hover-${index}`,
        actionId: `hover-${index}`,
        selector: `[data-lab="item-${index}"]`,
        durationMs: 100,
    }))
    const largeScenario = { ...scenario, name: 'large-semantic-fixture', actions }
    const catalogEntries = ANIMATION_LAB_METRIC_CATALOG_V1.slice(0, 3)
    const runMetric = decorateLabMetric(frameMetric(8), { level: 'run' }, { acrossAttempts: true })
    const actionMetrics = actions.flatMap(action =>
        catalogEntries.map(entry =>
            decorateLabMetric(
                {
                    family: entry.family,
                    name: entry.name,
                    stat: entry.stat,
                    unit: entry.unit,
                    value: 1,
                    samples: 120,
                    status: 'measured',
                    evidenceLevel: 'controlled-lab-measurement',
                },
                { level: 'action', actionId: action.actionId },
                { acrossAttempts: true }
            )
        )
    )

    const semantics = buildAnimationLabSemantics({
        scenario: largeScenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts: [],
        aggregateMetrics: [...actionMetrics.reverse(), runMetric],
    })

    assert.equal(semantics.metrics.length, 256)
    assert.equal(semantics.metrics[0].scope.level, 'run')
    assert.ok(semantics.metrics.some(metric => metric.scope.actionId === 'hover-99'))
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
    assert.ok(
        semantics.technologyEvidence
            .find(item => item.evidenceId === 'runtime-browser')
            .limitations.includes('canonical-metric-projection-truncated')
    )
})

test('projects every report attempt to the platform limit without starving later actions', () => {
    const actions = Array.from({ length: 100 }, (_, index) => ({
        kind: 'hover',
        label: `hover-${index}`,
        actionId: `hover-${index}`,
        selector: `[data-lab="item-${index}"]`,
        durationMs: 100,
    }))
    const largeScenario = { ...scenario, name: 'large-attempt-fixture', actions }
    const scenarioActions = actions.map((action, order) => ({
        actionId: action.actionId,
        order,
        kind: action.kind,
        label: action.label,
        trigger: { source: 'scenario' },
    }))
    const attemptId = 'large-attempt'
    const rootMetrics = ANIMATION_LAB_METRIC_CATALOG_V1.slice(0, 43).map(entry =>
        decorateLabMetric(
            {
                family: entry.family,
                name: entry.name,
                stat: entry.stat,
                unit: entry.unit,
                value: 1,
                samples: 120,
                status: 'measured',
                evidenceLevel: 'controlled-lab-measurement',
                metricId: entry.metricId,
            },
            { level: 'attempt', attemptId }
        )
    )
    const actionCatalog = ANIMATION_LAB_METRIC_CATALOG_V1.slice(0, 13)
    const actionMetrics = actions.flatMap(action =>
        actionCatalog.map(entry =>
            decorateLabMetric(
                {
                    family: entry.family,
                    name: entry.name,
                    stat: entry.stat,
                    unit: entry.unit,
                    value: 1,
                    samples: 120,
                    status: 'measured',
                    evidenceLevel: 'controlled-lab-measurement',
                    metricId: entry.metricId,
                },
                { level: 'action', attemptId, actionId: action.actionId }
            )
        )
    )
    const measuredAttempt = {
        attemptId,
        phase: 'measured',
        index: 0,
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        metrics: [...actionMetrics.reverse(), ...rootMetrics],
        capabilities: {},
        limitations: [],
    }
    const warmupAttempt = { ...measuredAttempt, attemptId: 'warmup-attempt', phase: 'warmup', index: 0 }
    const projected = projectAttemptsForReport([warmupAttempt, measuredAttempt], scenarioActions)

    assert.equal(projected[0].metrics.length, 0)
    assert.equal(projected[0].actionWindows, undefined)
    assert.ok(projected[0].limitations.includes('warmup-detail-omitted-from-report'))
    assert.equal(projected[1].metrics.length, 256)
    assert.ok(projected[1].metrics.some(metric => metric.scope.actionId === 'hover-99'))
    assert.ok(projected[1].limitations.includes('attempt-metric-projection-truncated'))
    assert.equal(JSON.stringify(projected).includes('[data-lab'), false)
    assert.equal(largeScenario.actions.length, 100)
})

test('projects declared technology evidence fairly and keeps declarations distinct from observations', () => {
    const actions = Array.from({ length: 100 }, (_, index) => ({
        kind: 'wait',
        label: `technology-${index}`,
        actionId: `technology-${index}`,
        durationMs: 1,
        subject: { scope: 'page', role: 'scene', surface: 'webgl' },
        technologies: [
            { axis: 'ui-framework', technologyKey: `framework-${index}` },
            { axis: 'renderer', technologyKey: `renderer-${index}` },
            { axis: 'motion-engine', technologyKey: `motion-${index}` },
            { axis: 'meta-runtime', technologyKey: `runtime-${index}` },
        ],
    }))
    const semantics = buildAnimationLabSemantics({
        scenario: { ...scenario, name: 'technology-projection-fixture', actions },
        browser: { name: 'chromium', version: '140.0.0' },
        attempts: [],
        aggregateMetrics: [decorateLabMetric(frameMetric(8), { level: 'run' }, { acrossAttempts: true })],
    })

    assert.equal(semantics.technologyEvidence.length, 256)
    assert.ok(
        semantics.technologyEvidence.some(
            item =>
                item.technologyKey === 'framework-99' &&
                item.scope.actionId === 'technology-99' &&
                item.status === 'declared' &&
                item.source === 'scenario-declaration'
        )
    )
    assert.ok(
        semantics.technologyEvidence.some(
            item => item.technologyKey === 'webgl' && item.scope.actionId === 'technology-99' && item.status === 'declared'
        )
    )
    assert.ok(
        semantics.technologyEvidence
            .find(item => item.evidenceId === 'runtime-browser')
            .limitations.includes('technology-evidence-projection-truncated')
    )
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('finding identity distinguishes a run-scoped action id from the run scope', () => {
    const runNamedScenario = {
        ...scenario,
        name: 'run-id-fixture',
        actions: [{ ...scenario.actions[0], actionId: 'run' }],
    }
    const semantics = buildAnimationLabSemantics({
        scenario: runNamedScenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts: [],
        aggregateMetrics: [
            decorateLabMetric(frameMetric(30), { level: 'run' }, { acrossAttempts: true }),
            decorateLabMetric(frameMetric(30), { level: 'action', actionId: 'run' }, { acrossAttempts: true }),
        ],
    })

    assert.equal(semantics.findings.length, 2)
    assert.equal(new Set(semantics.findings.map(finding => finding.findingId)).size, 2)
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('aggregation keeps actionId run distinct from the run scope', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `scope-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(frameMetric(10, 40), { level: 'attempt', attemptId }),
                decorateLabMetric(frameMetric(30, 40), { level: 'action', attemptId, actionId: 'run' }),
            ],
            capabilities: {},
            limitations: [],
        }
    })

    const metrics = aggregateMeasuredAttempts(attempts)
    assert.equal(metrics.length, 2)
    assert.deepEqual(
        metrics.map(metric => ({ scope: metric.scope, value: metric.value, samples: metric.samples, status: metric.status })),
        [
            { scope: { level: 'run' }, value: 10, samples: 120, status: 'measured' },
            { scope: { level: 'action', actionId: 'run' }, value: 30, samples: 120, status: 'measured' },
        ]
    )
})

test('uses a true even-sample median for metrics and action windows', () => {
    const values = [1, 2, 100, 101]
    const starts = [0, 10, 100, 110]
    const durations = [10, 20, 100, 110]
    const attempts = values.map((value, index) => {
        const attemptId = `even-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [decorateLabMetric(frameMetric(value), { level: 'attempt', attemptId })],
            actionWindows: [
                actionWindowFromProbe(scenario.actions[0], 0, {
                    startedAtMs: starts[index],
                    endedAtMs: starts[index] + durations[index],
                    outcome: 'completed',
                }),
            ],
            capabilities: {},
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(aggregateMetrics[0].value, 51)
    assert.equal(semantics.actionWindows[0].timestamps.startedAtMs, 55)
    assert.equal(semantics.actionWindows[0].timestamps.durationMs, 60)
})

test('marks an aggregate partial when the exact summed sample count exceeds the report bound', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `bounded-samples-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    {
                        family: 'resourcesMedia',
                        name: 'videoDroppedFrameRate',
                        stat: 'ratio',
                        unit: 'ratio',
                        value: (index + 1) / 10,
                        samples: 4_000_000,
                        status: 'measured',
                        evidenceLevel: 'controlled-lab-measurement',
                    },
                    { level: 'attempt', attemptId }
                ),
            ],
            capabilities: {},
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(aggregateMetrics[0].value, 0.2)
    assert.equal(aggregateMetrics[0].samples, null)
    assert.equal(aggregateMetrics[0].status, 'partial')
    assert.ok(aggregateMetrics[0].limitations.includes('aggregate-sample-count-exceeds-contract-bound'))
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
    assert.equal(semantics.findings.length, 0)
})

test('marks a metric partial when it is missing from measured attempts', () => {
    const attempts = Array.from({ length: 10 }, (_, index) => {
        const attemptId = `coverage-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: index < 3 ? [decorateLabMetric(frameMetric(index + 1), { level: 'attempt', attemptId })] : [],
            capabilities: {},
            limitations: [],
        }
    })
    const [metric] = aggregateMeasuredAttempts(attempts)
    assert.equal(metric.status, 'partial')
    assert.ok(metric.limitations.includes('eligible-attempts-3'))
    assert.ok(metric.limitations.includes('total-attempts-10'))
})

test('does not upgrade cross-document partial samples or their findings to observed', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `cross-document-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    { ...frameMetric(30, 40), status: 'partial', limitations: ['cross-document-sampling-partial'] },
                    { level: 'attempt', attemptId }
                ),
            ],
            capabilities: {},
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(aggregateMetrics[0].status, 'partial')
    assert.equal(semantics.findings[0].status, 'candidate')
    assert.ok(semantics.findings[0].limitations.includes('cross-document-sampling-partial'))
})

test('preserves the Event Timing threshold population on aggregates and input-delay findings', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `event-timing-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    {
                        family: 'userOutcome',
                        name: 'inputDelayMs',
                        stat: 'p95',
                        unit: 'ms',
                        value: 150,
                        samples: 3,
                        status: 'measured',
                        evidenceLevel: 'controlled-lab-measurement',
                        limitations: ['event-timing-duration-threshold-16ms'],
                    },
                    { level: 'attempt', attemptId }
                ),
            ],
            capabilities: {},
            limitations: [],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(aggregateMetrics[0].metricId, 'interaction.input-delay.p95')
    assert.equal(aggregateMetrics[0].samples, 9)
    assert.ok(aggregateMetrics[0].limitations.includes('event-timing-duration-threshold-16ms'))
    const finding = semantics.findings.find(item => item.ruleId === 'input-delay')
    assert.equal(finding.status, 'observed')
    assert.ok(finding.limitations.includes('event-timing-duration-threshold-16ms'))
    assert.ok(finding.limitations.includes('diagnostic-project-budget-not-web-standard'))
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})

test('keeps a budget violation from a truncated page-probe distribution as a candidate', () => {
    const attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `truncated-probe-${index}`
        return {
            attemptId,
            phase: 'measured',
            index,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:00:01.000Z',
            durationMs: 1_000,
            metrics: [
                decorateLabMetric(
                    {
                        ...frameMetric(30, 20_000),
                        status: 'partial',
                        limitations: ['page-probe-frame-samples-truncated'],
                    },
                    { level: 'attempt', attemptId }
                ),
            ],
            capabilities: {},
            limitations: ['page-probe-samples-truncated'],
        }
    })
    const aggregateMetrics = aggregateMeasuredAttempts(attempts)
    const semantics = buildAnimationLabSemantics({
        scenario,
        browser: { name: 'chromium', version: '140.0.0' },
        attempts,
        aggregateMetrics,
    })

    assert.equal(aggregateMetrics[0].status, 'partial')
    assert.equal(semantics.findings[0].status, 'candidate')
    assert.ok(semantics.findings[0].limitations.includes('page-probe-frame-samples-truncated'))
    assert.equal(validateAnimationLabSemanticsV2(semantics).ok, true)
})
