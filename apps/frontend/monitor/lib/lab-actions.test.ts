import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LabRun, LabRunAnalysis, LabTimelineEvent } from '../types/lab'
import { buildLabActionDiagnostics, resolveLabBudgetRule } from './lab-actions'

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
            target: 12.4999995,
            unit: 'ms',
            minimumSamples: 120,
        })
        assert.equal(
            resolveLabBudgetRule({ catalogVersion: 1, budgetId: 'unknown-budget', budgetVersion: 1, ruleId: 'frame-tail' }, contract),
            null
        )
    })
})
