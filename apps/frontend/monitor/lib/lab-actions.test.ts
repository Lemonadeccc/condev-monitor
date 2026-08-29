import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LabMetric, LabRun, LabRunAnalysis, LabTimelineEvent, LabTraceActionPhaseSummary } from '../types/lab'
import {
    buildLabActionDiagnostics,
    evaluateLabBudgetMetric,
    getLabBudgetRuleEvidenceRequirement,
    resolveLabBudgetRule,
} from './lab-actions'

const run: LabRun = {
    runId: 'run-1',
    appId: 'app-1',
    name: 'Animation lab',
    status: 'completed',
    source: 'local-runner',
    createdAt: '2026-08-26T00:00:00.000Z',
}

describe('buildLabActionDiagnostics', () => {
    it('joins canonical semantic evidence by actionId without inventing budget values', () => {
        const profileRef = { catalogVersion: 1 as const, budgetId: 'default-animation-lab', budgetVersion: 1 }
        const budgetRef = { ...profileRef, ruleId: 'frame-p95' }
        const analysis: LabRunAnalysis = {
            semanticsVersion: 2,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 120,
                targetFrameMs: 8.333,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: profileRef,
                metricCatalogVersion: 1,
            },
            scenarioActions: [
                {
                    actionId: 'hero-hover',
                    order: 0,
                    kind: 'hover',
                    label: 'hero-hover',
                    trigger: { source: 'scenario' },
                    subject: { scope: 'renderer-surface', subjectKey: 'hero-canvas', surface: 'webgl' },
                },
            ],
            actionWindows: [
                {
                    actionId: 'hero-hover',
                    order: 0,
                    kind: 'hover',
                    trigger: { source: 'scenario' },
                    subject: { scope: 'renderer-surface', subjectKey: 'hero-canvas', surface: 'webgl' },
                    outcome: { status: 'completed' },
                    timestamps: { clock: 'attempt-monotonic', startedAtMs: 10, endedAtMs: 110, durationMs: 100 },
                    evidenceRefs: ['tech-three'],
                    limitations: [],
                },
            ],
            metrics: [
                {
                    metricId: 'frame.interval.p95',
                    family: 'frameCadence',
                    name: 'frameDurationMs',
                    stat: 'p95',
                    unit: 'ms',
                    value: 10,
                    samples: 50,
                    status: 'measured',
                    evidenceLevel: 'controlled-lab-measurement',
                    scope: { level: 'action', actionId: 'hero-hover' },
                    aggregation: { population: 'frames', method: 'nearest-rank' },
                    budgetRefs: [budgetRef],
                    evidenceRefs: ['tech-three'],
                    limitations: [],
                },
            ],
            technologyEvidence: [
                {
                    evidenceId: 'tech-three',
                    axis: 'renderer',
                    technologyKey: 'three',
                    source: 'host-adapter',
                    confidence: 'high',
                    status: 'observed',
                    scope: { level: 'action', actionId: 'hero-hover' },
                    actionId: 'hero-hover',
                    limitations: [],
                },
            ],
            findings: [
                {
                    findingId: 'finding-frame-tail',
                    ruleId: 'frame-p95',
                    severity: 'warning',
                    status: 'observed',
                    scope: { level: 'action', actionId: 'hero-hover' },
                    metricIds: ['frame.interval.p95'],
                    evidenceRefs: ['tech-three'],
                    budgetRefs: [budgetRef],
                    actionIds: ['hero-hover'],
                    limitations: [],
                },
            ],
        }
        const events: LabTimelineEvent[] = [
            {
                eventId: 'event-1',
                name: 'RunTask',
                category: 'script',
                startTimeMs: 20,
                durationMs: 5,
                actionId: 'hero-hover',
            },
        ]

        const result = buildLabActionDiagnostics(run, analysis, events)

        assert.equal(result.actions.length, 1)
        assert.equal(result.actions[0].source, 'structured-report')
        assert.equal(result.actions[0].action.subject?.surface, 'webgl')
        assert.equal(result.actions[0].timelineRelation, 'action-id')
        assert.equal(result.actions[0].metrics.length, 1)
        assert.equal(result.actions[0].technologies[0]?.technologyKey, 'three')
        assert.equal(result.actions[0].findings.length, 1)
        assert.equal(result.actions[0].budgetRefs[0]?.ruleId, 'frame-p95')
    })

    it('marks timeline-label recovery as legacy and keeps missing semantics unknown', () => {
        const legacyRun: LabRun = {
            ...run,
            summary: {
                metrics: [
                    {
                        family: 'renderer',
                        name: 'gpuFrameMs',
                        stat: 'p95',
                        unit: 'ms',
                        value: null,
                        samples: null,
                        status: 'unsupported',
                    },
                ],
            },
        }
        const events: LabTimelineEvent[] = [
            {
                eventId: 'legacy-event',
                name: 'Animation',
                category: 'animation',
                startTimeMs: 20,
                durationMs: 8,
                attributes: { actionLabel: 'legacy-hover' },
            },
        ]

        const result = buildLabActionDiagnostics(legacyRun, null, events)
        const recovered = result.actions[0]

        assert.equal(recovered.source, 'legacy-timeline-label')
        assert.equal(recovered.action.kind, null)
        assert.equal(recovered.action.subject, null)
        assert.equal(recovered.action.timestamps?.durationMs, 8)
        assert.equal(recovered.metrics.length, 0)
        assert.equal(recovered.unscopedMetricCount, 1)
    })

    it('keeps run and attempt metrics out of an action even when a finding references the same metric id', () => {
        const baseMetric = {
            metricId: 'frame.interval.p95',
            family: 'frameCadence',
            name: 'frameDurationMs',
            stat: 'p95',
            unit: 'ms',
            value: 12,
            samples: 120,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement' as const,
            aggregation: { population: 'frames', method: 'nearest-rank' },
            budgetRefs: [],
            evidenceRefs: ['runtime-browser'],
            limitations: [],
        }
        const analysis: LabRunAnalysis = {
            semanticsVersion: 2,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
                metricCatalogVersion: 2,
            },
            scenarioActions: [
                {
                    actionId: 'open-card',
                    order: 0,
                    kind: 'click',
                    label: 'open-card',
                    trigger: { source: 'scenario' },
                    subject: { scope: 'subject', subjectKey: 'product-card', surface: 'dom' },
                },
            ],
            actionWindows: [],
            metrics: [
                { ...baseMetric, scope: { level: 'run' } },
                { ...baseMetric, scope: { level: 'attempt', attemptId: 'attempt-1' } },
                { ...baseMetric, scope: { level: 'action', actionId: 'open-card' } },
                {
                    ...baseMetric,
                    scope: { level: 'subject', actionId: 'open-card', subjectKey: 'product-card' },
                },
            ],
            technologyEvidence: [],
            findings: [
                {
                    findingId: 'finding-frame-tail',
                    ruleId: 'frame-tail',
                    severity: 'warning',
                    status: 'observed',
                    scope: { level: 'action', actionId: 'open-card' },
                    metricIds: ['frame.interval.p95'],
                    evidenceRefs: ['runtime-browser'],
                    budgetRefs: [],
                    actionIds: ['open-card'],
                    limitations: [],
                },
            ],
        }

        const diagnostic = buildLabActionDiagnostics(run, analysis, []).actions[0]

        assert.deepEqual(
            diagnostic.metrics.map(metric => metric.scope?.level),
            ['action', 'subject']
        )
        assert.equal(diagnostic.unscopedMetricCount, 2)
    })

    it('does not expose an unsafe subject token even if a malformed client payload bypasses backend validation', () => {
        const analysis = {
            semanticsVersion: 2,
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: { catalogVersion: 1, budgetId: 'default-animation-lab', budgetVersion: 1 },
                metricCatalogVersion: 1,
            },
            scenarioActions: [
                {
                    actionId: 'click-card',
                    order: 0,
                    kind: 'click',
                    label: 'click-card',
                    trigger: { source: 'scenario' },
                    subject: { scope: 'subject', subjectKey: '#private input[name=email]', surface: 'dom' },
                },
            ],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        } as unknown as LabRunAnalysis

        const result = buildLabActionDiagnostics(run, analysis, [])

        assert.equal(result.actions[0].action.subject?.subjectKey, undefined)
        assert.equal(result.actions[0].action.subject?.surface, 'dom')
    })

    it('keeps touch and pen action kinds from structured reports', () => {
        for (const kind of ['touch-tap', 'touch-swipe', 'touch-pinch', 'pen-path'] as const) {
            const analysis = {
                semanticsVersion: 2,
                scenarioActions: [
                    {
                        actionId: `${kind}-hero`,
                        order: 0,
                        kind,
                        label: `${kind}-hero`,
                        trigger: { source: 'scenario' },
                    },
                ],
                actionWindows: [],
                metrics: [],
                technologyEvidence: [],
                findings: [],
            } as unknown as LabRunAnalysis

            const result = buildLabActionDiagnostics(run, analysis, [])
            assert.equal(result.actions[0].action.kind, kind)
            assert.equal(result.actions[0].source, 'structured-report')
        }
    })

    it('joins an optional trace phase summary by actionId without attaching it to another action', () => {
        const analysis = {
            semanticsVersion: 2,
            scenarioActions: [
                {
                    actionId: 'open-card',
                    order: 0,
                    kind: 'click',
                    label: 'open-card',
                    trigger: { source: 'scenario' },
                },
                {
                    actionId: 'close-card',
                    order: 1,
                    kind: 'click',
                    label: 'close-card',
                    trigger: { source: 'scenario' },
                },
            ],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        } as unknown as LabRunAnalysis
        const summary: LabTraceActionPhaseSummary = {
            actionId: 'close-card',
            actionLabel: 'close-card',
            startMs: 20,
            endMs: 50,
            wallTimeMs: 30,
            status: 'partial',
            eventCount: 2,
            classifiedThreadTimeMs: 35,
            threads: [
                {
                    threadId: 'thread-0',
                    thread: 'main',
                    classifiedSelfTimeMs: 25,
                    phases: {
                        script: 20,
                        'style-layout': 5,
                        paint: 0,
                        composite: 0,
                        'raster-gpu': 0,
                        animation: 0,
                        gc: 0,
                        other: 0,
                    },
                },
                {
                    threadId: 'thread-1',
                    thread: 'raster',
                    classifiedSelfTimeMs: 10,
                    phases: {
                        script: 0,
                        'style-layout': 0,
                        paint: 0,
                        composite: 0,
                        'raster-gpu': 10,
                        animation: 0,
                        gc: 0,
                        other: 0,
                    },
                },
            ],
            limitations: ['trace-action-cross-thread-total-may-exceed-wall-time'],
        }

        const result = buildLabActionDiagnostics(run, analysis, [], [summary])

        assert.equal(result.actions[0].tracePhaseSummary, null)
        assert.equal(result.actions[1].tracePhaseSummary, summary)
        assert.equal(result.actions[1].tracePhaseSummary?.classifiedThreadTimeMs, 35)
    })

    it('keeps v1 timelines unchanged when no action phase summaries are present', () => {
        const analysis = {
            semanticsVersion: 2,
            scenarioActions: [
                {
                    actionId: 'hero-hover',
                    order: 0,
                    kind: 'hover',
                    label: 'hero-hover',
                    trigger: { source: 'scenario' },
                },
            ],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        } as unknown as LabRunAnalysis

        assert.equal(buildLabActionDiagnostics(run, analysis, []).actions[0].tracePhaseSummary, null)
    })
})

describe('resolveLabBudgetRule', () => {
    it('expands only the matching bundled version and derives frame tail from the measurement contract', () => {
        const contract: LabRunAnalysis['measurementContract'] = {
            contractVersion: 2,
            expectedHz: 120,
            targetFrameMs: 8.333333,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
            metricCatalogVersion: 1,
        }
        assert.deepEqual(resolveLabBudgetRule({ ...contract.budgetRef, ruleId: 'frame-tail' }, contract), {
            comparator: '<=',
            metricId: 'frame.duration.p95',
            target: 12.4999995,
            unit: 'ms',
            minimumSamples: 120,
            zeroEventCountIsComplete: false,
        })
        assert.equal(
            resolveLabBudgetRule({ catalogVersion: 1, budgetId: 'unknown-budget', budgetVersion: 1, ruleId: 'frame-tail' }, contract),
            null
        )
    })

    it('distinguishes v1 and v2 Long Task zero-event evidence without displaying a zero-sample minimum', () => {
        const contract = (budgetVersion: number): LabRunAnalysis['measurementContract'] => ({
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion },
            metricCatalogVersion: 2,
        })
        const ref = (budgetVersion: number) => ({
            catalogVersion: 1 as const,
            budgetId: 'condev.animation.default',
            budgetVersion,
            ruleId: 'long-task-count',
        })
        const metric = (overrides: Partial<LabMetric> = {}): LabMetric => ({
            metricId: 'main.long-task.count',
            family: 'mainThread',
            name: 'longTaskCount',
            stat: 'count',
            unit: 'count',
            value: 0,
            samples: 0,
            status: 'measured',
            ...overrides,
        })

        const v1 = resolveLabBudgetRule(ref(1), contract(1))
        const v2 = resolveLabBudgetRule(ref(2), contract(2))
        const v3 = resolveLabBudgetRule(ref(3), contract(3))
        assert.equal(v1?.minimumSamples, 1)
        assert.equal(v1?.zeroEventCountIsComplete, false)
        assert.equal(v2?.minimumSamples, 0)
        assert.equal(v2?.zeroEventCountIsComplete, true)
        assert.equal(v3?.minimumSamples, 0)
        assert.equal(v3?.zeroEventCountIsComplete, true)
        assert.equal(evaluateLabBudgetMetric(metric(), ref(1), contract(1)), 'insufficient-evidence')
        assert.equal(evaluateLabBudgetMetric(metric(), ref(2), contract(2)), 'within-budget')
        assert.equal(evaluateLabBudgetMetric(metric({ value: 1, samples: 1 }), ref(2), contract(2)), 'breach')
        assert.equal(evaluateLabBudgetMetric(metric({ value: 1, samples: 1, status: 'partial' }), ref(2), contract(2)), 'candidate-breach')
        assert.equal(evaluateLabBudgetMetric(metric({ status: 'partial' }), ref(2), contract(2)), 'insufficient-evidence')
        assert.equal(evaluateLabBudgetMetric(metric({ samples: null }), ref(2), contract(2)), 'insufficient-evidence')
        assert.equal(
            evaluateLabBudgetMetric(
                metric({
                    value: 1,
                    samples: null,
                    status: 'partial',
                    limitations: ['aggregate-sample-count-exceeds-contract-bound'],
                }),
                ref(2),
                contract(2)
            ),
            'insufficient-evidence'
        )
        assert.equal(evaluateLabBudgetMetric(metric({ samples: 1 }), ref(2), contract(2)), 'insufficient-evidence')
        assert.equal(evaluateLabBudgetMetric(metric({ value: 1 }), ref(2), contract(2)), 'insufficient-evidence')

        const requirement = getLabBudgetRuleEvidenceRequirement(v2!)
        assert.match(requirement, /完整 measured 观察允许 0 个 Long Task/u)
        assert.doesNotMatch(requirement, /最少\s*0/u)
        assert.equal(resolveLabBudgetRule(ref(5), contract(5)), null)
        assert.equal(resolveLabBudgetRule(ref(2), contract(1)), null)
    })

    it('expands the seven evidence-gated diagnostic rules only for budget v3', () => {
        const contractFor = (budgetVersion: 1 | 2 | 3): LabRunAnalysis['measurementContract'] => ({
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion },
            metricCatalogVersion: 2,
        })
        const contract = contractFor(3)
        const cases = [
            ['loaf-count', 'main.loaf.count', 0, 'count', 0],
            ['interaction-processing-tail', 'interaction.processing.p95', 50, 'ms', 3],
            ['interaction-presentation-tail', 'interaction.presentation.p95', 100, 'ms', 3],
            ['page-lcp', 'vital.lcp.latest', 2_500, 'ms', 1],
            ['page-cls', 'vital.cls.latest', 0.1, 'score', 1],
            ['lighthouse-first-contentful-paint', 'lighthouse.fcp.latest', 1_800, 'ms', 1],
            ['lighthouse-total-blocking-time', 'lighthouse.total-blocking-time.latest', 200, 'ms', 1],
        ] as const

        for (const [ruleId, metricId, target, unit, minimumSamples] of cases) {
            const ref = { ...contract.budgetRef, ruleId }
            assert.deepEqual(resolveLabBudgetRule(ref, contract), {
                comparator: '<=',
                metricId,
                target,
                unit,
                minimumSamples,
                zeroEventCountIsComplete: ruleId === 'loaf-count',
            })
            if (ruleId === 'loaf-count')
                assert.match(getLabBudgetRuleEvidenceRequirement(resolveLabBudgetRule(ref, contract)!), /0 个 LoAF/u)
            const metric = {
                metricId,
                family: 'userOutcome',
                name: 'diagnosticMetric',
                stat: 'p95',
                unit,
                value: target + 1,
                samples: minimumSamples === 0 ? 1 : minimumSamples,
                status: 'measured',
            } as LabMetric
            assert.equal(evaluateLabBudgetMetric(metric, ref, contract), 'breach')
            assert.equal(evaluateLabBudgetMetric({ ...metric, status: 'partial' }, ref, contract), 'candidate-breach')
            assert.equal(
                evaluateLabBudgetMetric({ ...metric, samples: minimumSamples === 0 ? 0 : minimumSamples - 1 }, ref, contract),
                'insufficient-evidence'
            )
            assert.equal(
                evaluateLabBudgetMetric({ ...metric, value: null, samples: null, status: 'unsupported' }, ref, contract),
                'insufficient-evidence'
            )
        }

        for (const budgetVersion of [1, 2] as const) {
            const earlierContract = contractFor(budgetVersion)
            for (const [ruleId] of cases) {
                assert.equal(resolveLabBudgetRule({ ...earlierContract.budgetRef, ruleId }, earlierContract), null)
            }
        }

        assert.ok(resolveLabBudgetRule({ ...contract.budgetRef, ruleId: 'frame-tail' }, contract))
    })

    it('expands the renderer GPU tail rule only for budget v4', () => {
        const contract = (budgetVersion: 3 | 4): LabRunAnalysis['measurementContract'] => ({
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion },
            metricCatalogVersion: budgetVersion,
        })
        const v4 = contract(4)
        const ref = { ...v4.budgetRef, ruleId: 'renderer-gpu-frame-tail' }

        assert.deepEqual(resolveLabBudgetRule(ref, v4), {
            comparator: '<=',
            metricId: 'renderer.gpu-frame.p95',
            target: 16.666667 * 0.8,
            unit: 'ms',
            minimumSamples: 30,
            zeroEventCountIsComplete: false,
        })
        assert.equal(resolveLabBudgetRule({ ...contract(3).budgetRef, ruleId: ref.ruleId }, contract(3)), null)
        assert.equal(
            evaluateLabBudgetMetric(
                {
                    metricId: 'renderer.gpu-frame.p95',
                    family: 'renderer',
                    name: 'gpuFrameMs',
                    stat: 'p95',
                    unit: 'ms',
                    value: 14,
                    samples: 30,
                    status: 'measured',
                },
                ref,
                v4
            ),
            'breach'
        )
    })
})
