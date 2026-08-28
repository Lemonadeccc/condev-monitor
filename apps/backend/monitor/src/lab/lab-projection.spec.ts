import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

import { LAB_RUN_SUMMARY_MAX_BYTES, parseLabRunSummary } from './lab.contracts'
import {
    LAB_COMPACT_SUMMARY_METRICS_TRUNCATED,
    LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED,
    LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
    parseAnimationReportArtifact,
    parseTraceIndexArtifact,
} from './lab-projection'

function traceEvent(index = 0) {
    return {
        id: `trace-${index}`,
        category: 'script',
        name: 'RunTask',
        startMs: index,
        durationMs: 55,
        selfTimeMs: 30,
        thread: 'main',
        stack: [{ functionName: 'render', source: '/assets/app.js', line: 12, column: 4 }],
        actionLabel: 'hover-card',
    }
}

function traceIndex(events = [traceEvent()]) {
    return {
        schemaVersion: 1,
        startMs: 0,
        endMs: Math.max(100, events.length + 60),
        totalInputEvents: events.length + 3,
        retainedEvents: events.length,
        droppedEvents: 0,
        events,
        categoryDurationMs: {
            interaction: 0,
            script: 55,
            'style-layout': 0,
            paint: 0,
            composite: 0,
            'raster-gpu': 0,
            network: 0,
            animation: 0,
            gc: 0,
            other: 0,
        },
    }
}

function metric(overrides: Record<string, unknown> = {}) {
    return {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value: 18.4,
        samples: 120,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        ...overrides,
    }
}

function budgetRuleRef() {
    return {
        catalogVersion: 1,
        budgetId: 'condev.animation.default',
        budgetVersion: 1,
        ruleId: 'frame-tail',
    }
}

type TestFinding = {
    findingId: string
    ruleId: string
    severity: 'info' | 'warning' | 'critical'
    status: 'observed' | 'candidate' | 'not-observed' | 'unsupported'
    scope: { level: 'run' | 'action' | 'subject'; actionId?: string; subjectKey?: string }
    metricIds: string[]
    evidenceRefs: string[]
    budgetRefs: ReturnType<typeof budgetRuleRef>[]
    actionIds: string[]
    limitations: string[]
}

function frameTailFinding(overrides: Partial<TestFinding> = {}): TestFinding {
    return {
        findingId: 'finding-frame-tail-run-all',
        ruleId: 'frame-tail',
        severity: 'warning',
        status: 'candidate',
        scope: { level: 'run' },
        metricIds: ['frame.duration.p95'],
        evidenceRefs: ['runtime-browser'],
        budgetRefs: [budgetRuleRef()],
        actionIds: [],
        limitations: ['eligible-attempts-1', 'total-attempts-1', 'diagnostic-project-budget-not-web-standard'],
        ...overrides,
    }
}

function expandedMetric(overrides: Record<string, unknown> = {}) {
    const scope = overrides.scope as { attemptId?: unknown } | undefined
    const attemptScoped = typeof scope?.attemptId === 'string'
    const eligibleAttempts = overrides.value === null ? 0 : 1
    const overrideLimitations = Array.isArray(overrides.limitations) ? (overrides.limitations as string[]) : []
    const hasAttemptCoverage = overrideLimitations.some(
        limitation => limitation.startsWith('eligible-attempts-') || limitation.startsWith('total-attempts-')
    )
    return {
        ...metric(),
        metricId: 'frame.duration.p95',
        scope: { level: 'run' },
        aggregation: { population: 'attempts', method: 'median-of-attempts' },
        budgetRefs: [budgetRuleRef()],
        evidenceRefs: ['runtime-browser'],
        status: attemptScoped ? 'measured' : 'partial',
        ...overrides,
        limitations:
            attemptScoped || hasAttemptCoverage
                ? overrideLimitations
                : [...overrideLimitations, `eligible-attempts-${eligibleAttempts}`, 'total-attempts-1'],
    }
}

function loafPaintMetric(overrides: Record<string, unknown> = {}) {
    return expandedMetric({
        family: 'renderingPipeline',
        name: 'longAnimationFrameRenderStartToPaintMs',
        stat: 'p95',
        unit: 'ms',
        metricId: 'pipeline.loaf-render-start-to-paint.p95',
        budgetRefs: [],
        ...overrides,
    })
}

function videoWindowMetric(overrides: Record<string, unknown> = {}) {
    return expandedMetric({
        family: 'resourcesMedia',
        name: 'videoWindowDroppedFrameRate',
        stat: 'ratio',
        unit: 'ratio',
        value: 0.03,
        samples: 100,
        metricId: 'media.video-window-dropped-frame-rate',
        scope: { level: 'action', actionId: 'hero-hover-01' },
        aggregation: { population: 'attempts', method: 'median-of-attempts' },
        budgetRefs: [],
        limitations: [
            'video-playback-quality-window-counter-delta',
            'video-playback-quality-total-includes-displayed-and-dropped',
            'video-playback-quality-window-object-identity-only',
            'video-playback-quality-not-decode-presentation-or-gpu-timing',
        ],
        ...overrides,
    })
}

type RendererMetricId = 'renderer.draw-calls.p95' | 'renderer.triangles.p95' | 'renderer.gpu-frame.p95'

function rendererMetric(metricId: RendererMetricId, overrides: Record<string, unknown> = {}) {
    const gpu = metricId === 'renderer.gpu-frame.p95'
    const triangles = metricId === 'renderer.triangles.p95'
    return expandedMetric({
        family: 'renderer',
        name: gpu ? 'gpuFrameMs' : triangles ? 'triangles' : 'drawCalls',
        stat: 'p95',
        unit: gpu ? 'ms' : 'count',
        value: gpu ? 20 : triangles ? 10_000 : 50,
        samples: 30,
        metricId,
        aggregation: { population: 'attempts', method: 'median-of-attempts' },
        budgetRefs: gpu
            ? [
                  {
                      catalogVersion: 1,
                      budgetId: 'condev.animation.default',
                      budgetVersion: 4,
                      ruleId: 'renderer-gpu-frame-tail',
                  },
              ]
            : [],
        evidenceRefs: ['lab-renderer-adapter'],
        limitations: [
            gpu ? 'renderer-host-gpu-query-p95' : 'renderer-host-sample-p95',
            'renderer-multiple-producers-not-distinguished',
            ...(gpu ? ['renderer-gpu-action-window-not-proven'] : []),
            'eligible-attempts-3',
            'total-attempts-3',
        ],
        ...overrides,
    })
}

const ADDITIONAL_CATALOG_V2_METRICS = [
    {
        metricId: 'main.input-capture-to-next-raf-callback.count',
        family: 'mainThread',
        name: 'inputCaptureToNextRafCallbackCount',
        stat: 'count',
        unit: 'count',
        capability: 'inputFrameScheduling',
    },
    {
        metricId: 'main.input-capture-to-next-raf-callback.p95',
        family: 'mainThread',
        name: 'inputCaptureToNextRafCallbackMs',
        stat: 'p95',
        unit: 'ms',
        capability: 'inputFrameScheduling',
    },
    {
        metricId: 'interaction.loaf-first-ui-event-to-frame-end.count',
        family: 'userOutcome',
        name: 'longAnimationFrameFirstUIEventToFrameEndCount',
        stat: 'count',
        unit: 'count',
        capability: 'loafFirstUIEventTimestamp',
    },
    {
        metricId: 'interaction.loaf-first-ui-event-to-frame-end.p95',
        family: 'userOutcome',
        name: 'longAnimationFrameFirstUIEventToFrameEndMs',
        stat: 'p95',
        unit: 'ms',
        capability: 'loafFirstUIEventTimestamp',
    },
    {
        metricId: 'pipeline.loaf-attributed-forced-style-layout.count',
        family: 'renderingPipeline',
        name: 'longAnimationFrameAttributedForcedStyleAndLayoutCount',
        stat: 'count',
        unit: 'count',
        capability: 'loafForcedStyleAndLayoutDuration',
    },
    {
        metricId: 'pipeline.loaf-attributed-forced-style-layout.p95',
        family: 'renderingPipeline',
        name: 'longAnimationFrameAttributedForcedStyleAndLayoutMs',
        stat: 'p95',
        unit: 'ms',
        capability: 'loafForcedStyleAndLayoutDuration',
    },
] as const

function additionalCatalogV2Metric(definition: (typeof ADDITIONAL_CATALOG_V2_METRICS)[number], overrides: Record<string, unknown> = {}) {
    return expandedMetric({
        family: definition.family,
        name: definition.name,
        stat: definition.stat,
        unit: definition.unit,
        value: definition.stat === 'count' ? 2 : 12.5,
        samples: 2,
        metricId: definition.metricId,
        budgetRefs: [],
        ...overrides,
    })
}

function actionWindow() {
    return {
        actionId: 'hero-hover-01',
        order: 0,
        kind: 'hover',
        trigger: { source: 'scenario' },
        subject: { scope: 'subject', subjectKey: 'hero-card', role: 'region', surface: 'dom' },
        outcome: { status: 'completed' },
        timestamps: {
            clock: 'attempt-monotonic',
            startedAtMs: 100,
            endedAtMs: 450,
            durationMs: 350,
        },
        evidenceRefs: ['runtime-browser'],
        limitations: [],
    }
}

function animationReport() {
    return {
        schemaVersion: 1,
        runId: 'lab_local_result_1',
        scenario: {
            name: 'Hover card',
            routeKey: 'examples.hover-card',
            release: '1.0.0',
            dist: '',
            environment: 'development',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            reducedMotion: 'no-preference',
            cacheMode: 'warm',
            actionLabels: ['hover-card'],
        },
        browser: { name: 'chromium', version: '140.0.0', headless: true },
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: '2026-08-25T00:00:12.000Z',
        attempts: [
            {
                attemptId: 'attempt_1',
                phase: 'measured',
                index: 0,
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:00:10.000Z',
                durationMs: 10_000,
                metrics: [metric()],
                capabilities: { longtask: true },
                limitations: [],
            },
        ],
        aggregateMetrics: [metric()],
        lighthouse: {
            schemaVersion: 1,
            lighthouseVersion: '13.0.0',
            fetchTime: '2026-08-25T00:00:11.000Z',
            requestedRouteKey: 'examples.hover-card',
            categories: {
                performance: { title: 'Performance', score: 0.92 },
                accessibility: { title: 'Accessibility', score: 0.98 },
            },
            metrics: [metric({ family: 'lighthouse', name: 'LCP', stat: 'latest', value: 1_900 })],
            failedAudits: [
                {
                    id: 'unused-javascript',
                    title: 'Reduce unused JavaScript',
                    score: 0.5,
                    scoreDisplayMode: 'numeric',
                    numericValue: 300,
                    numericUnit: 'millisecond',
                    displayValue: 'Potential savings of 300 ms',
                    description: 'Remove code that is not needed by this route.',
                    savingsMs: 300,
                    savingsBytes: null,
                },
            ],
            diagnostics: [],
        },
        privacy: {
            selectorsRetained: false,
            inputValuesRetained: false,
            responseBodiesRetained: false,
            cookiesRetained: false,
            authorizationRetained: false,
            screenshotsRetained: false,
            rawTraceUploaded: false,
        },
    }
}

function animationReportV2() {
    const legacy = animationReport()
    return {
        ...legacy,
        lighthouse: {
            ...legacy.lighthouse,
            metrics: [
                metric({
                    family: 'lighthouse',
                    name: 'LCP',
                    stat: 'latest',
                    value: 1_900,
                    metricId: 'lighthouse.lcp.latest',
                }),
            ],
        },
        scenario: {
            ...legacy.scenario,
            actions: [
                {
                    actionId: 'hero-hover-01',
                    order: 0,
                    kind: 'hover',
                    label: 'hover-card',
                    subject: { scope: 'subject', subjectKey: 'hero-card', role: 'region', surface: 'dom' },
                    trigger: { source: 'scenario' },
                },
            ],
        },
        attempts: legacy.attempts.map(attempt => ({
            ...attempt,
            capabilities: {
                ...attempt.capabilities,
                loaf: true,
                loafPaintTime: true,
                loafPresentationTime: true,
            },
            metrics: [
                expandedMetric({
                    scope: { level: 'attempt', attemptId: 'attempt_1' },
                    aggregation: { population: 'frames', method: 'nearest-rank' },
                    limitations: [],
                }),
            ],
            actionWindows: [actionWindow()],
        })),
        aggregateMetrics: [expandedMetric()],
        semanticsVersion: 2,
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'observed',
            confidence: 'high',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
            metricCatalogVersion: 1,
        },
        actionWindows: [actionWindow()],
        technologyEvidence: [
            {
                evidenceId: 'runtime-browser',
                axis: 'browser-runtime',
                technologyKey: 'chromium',
                version: '140.0.0',
                source: 'runtime-probe',
                confidence: 'high',
                status: 'observed',
                scope: { level: 'run' },
                limitations: ['browser-outcomes-do-not-prove-framework-owner'],
            },
        ],
        findings: [] as TestFinding[],
    }
}

function candidateFrameTailReportV2(value = 30) {
    const report = animationReportV2()
    report.attempts[0]!.metrics[0]!.value = value
    report.aggregateMetrics[0]!.value = value
    report.findings = [frameTailFinding({ severity: value > 50.000001 ? 'critical' : 'warning' })]
    return report
}

function completeZeroLongTaskReportV2() {
    const report = animationReportV2()
    const budgetRef = { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2, ruleId: 'long-task-count' }
    const metricFor = (scope: Record<string, unknown>, aggregation: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
        expandedMetric({
            family: 'mainThread',
            name: 'longTaskCount',
            stat: 'count',
            unit: 'count',
            value: 0,
            samples: 0,
            metricId: 'main.long-task.count',
            scope,
            aggregation,
            budgetRefs: [budgetRef],
            limitations: [],
            ...overrides,
        })
    const source = report.attempts[0]!
    report.measurementContract.budgetRef.budgetVersion = 2
    report.measurementContract.metricCatalogVersion = 2
    report.attempts = Array.from({ length: 3 }, (_, index) => {
        const attemptId = `attempt_${index + 1}`
        return {
            ...source,
            attemptId,
            index,
            capabilities: { ...source.capabilities, longtask: true },
            metrics: [metricFor({ level: 'attempt', attemptId }, { population: 'tasks', method: 'count' })],
            actionWindows: [actionWindow()],
        }
    })
    report.aggregateMetrics = [
        metricFor(
            { level: 'run' },
            { population: 'attempts', method: 'median-of-attempts' },
            { status: 'measured', limitations: ['eligible-attempts-3', 'total-attempts-3'] }
        ),
    ]
    report.findings = []
    return report
}

function observedLongTaskReportV2() {
    const report = completeZeroLongTaskReportV2()
    const budgetRef = { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2, ruleId: 'long-task-count' }
    for (const attempt of report.attempts) {
        Object.assign(attempt.metrics[0]!, { value: 1, samples: 1 })
    }
    Object.assign(report.aggregateMetrics[0]!, { value: 1, samples: 3 })
    report.findings = [
        {
            findingId: 'finding-long-task-count-run-all',
            ruleId: 'long-task-count',
            severity: 'warning',
            status: 'observed',
            scope: { level: 'run' },
            metricIds: ['main.long-task.count'],
            evidenceRefs: ['runtime-browser'],
            budgetRefs: [budgetRef],
            actionIds: [],
            limitations: ['eligible-attempts-3', 'total-attempts-3', 'diagnostic-project-budget-not-web-standard'],
        },
    ]
    return report
}

function setReportBudgetVersion(report: ReturnType<typeof animationReportV2>, budgetVersion: number) {
    report.measurementContract.budgetRef.budgetVersion = budgetVersion
    for (const attempt of report.attempts) {
        for (const metric of attempt.metrics) {
            for (const ref of metric.budgetRefs) ref.budgetVersion = budgetVersion
        }
    }
    for (const metric of report.aggregateMetrics) {
        for (const ref of metric.budgetRefs) ref.budgetVersion = budgetVersion
    }
    for (const finding of report.findings) {
        for (const ref of finding.budgetRefs) ref.budgetVersion = budgetVersion
    }
    return report
}

function diagnosticProjectionReportV3() {
    const report = setReportBudgetVersion(completeZeroLongTaskReportV2(), 3)
    const traceAttemptId = 'attempt_trace'
    const lighthouseAttemptId = 'attempt_lighthouse'
    const traceMetric = expandedMetric({
        family: 'mainThread',
        name: 'trace.script.durationMs',
        stat: 'sum',
        unit: 'ms',
        value: 42,
        samples: 3,
        metricId: 'trace.script.duration',
        scope: { level: 'attempt', attemptId: traceAttemptId },
        aggregation: { population: 'events', method: 'sum' },
        budgetRefs: [],
        evidenceRefs: ['cdp-trace'],
        limitations: [],
    })
    const lighthouseMetric = expandedMetric({
        family: 'lighthouse',
        name: 'FCP',
        stat: 'latest',
        unit: 'ms',
        value: 1_200,
        samples: 1,
        metricId: 'lighthouse.fcp.latest',
        scope: { level: 'attempt', attemptId: lighthouseAttemptId },
        aggregation: { population: 'latest', method: 'latest' },
        budgetRefs: [
            {
                catalogVersion: 1,
                budgetId: 'condev.animation.default',
                budgetVersion: 3,
                ruleId: 'lighthouse-first-contentful-paint',
            },
        ],
        evidenceRefs: ['lighthouse'],
        limitations: [
            'separate-navigation-experiment',
            'lighthouse-form-factor-desktop',
            'lighthouse-isolated-process-does-not-inherit-measured-cache',
        ],
    })
    Object.assign(report.scenario, {
        execution: {
            warmupRuns: 0,
            measuredRuns: 3,
            trace: true,
            lighthouse: true,
            colorScheme: 'light',
            cpuThrottleRate: 1,
            network: null,
        },
    })
    ;(report.attempts as unknown as Array<Record<string, unknown>>).push(
        {
            attemptId: traceAttemptId,
            phase: 'diagnostic-trace',
            index: 0,
            startedAt: '2026-08-25T00:00:10.000Z',
            endedAt: '2026-08-25T00:00:11.000Z',
            durationMs: 1_000,
            observationDurationMs: 500,
            metrics: [traceMetric],
            capabilities: { cdpTrace: true, cpuProfile: true, screenshots: false },
            limitations: ['Trace category durations may overlap and are not exclusive CPU accounting.'],
            actionWindows: [],
        },
        {
            attemptId: lighthouseAttemptId,
            phase: 'lighthouse',
            index: 0,
            startedAt: '2026-08-25T00:00:11.000Z',
            endedAt: '2026-08-25T00:00:12.000Z',
            durationMs: 1_000,
            metrics: [lighthouseMetric],
            capabilities: { lighthouse: true, chromium: true },
            limitations: ['Lighthouse is a separate Chromium navigation experiment.'],
            actionWindows: [],
        }
    )
    report.aggregateMetrics.push({ ...traceMetric, scope: { level: 'run' } }, { ...lighthouseMetric, scope: { level: 'run' } })
    ;(report.technologyEvidence as unknown as Array<Record<string, unknown>>).push(
        {
            evidenceId: 'cdp-trace',
            axis: 'browser-runtime',
            technologyKey: 'chromium-devtools-trace',
            source: 'cdp-trace',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['trace-category-durations-may-overlap'],
        },
        {
            evidenceId: 'lighthouse',
            axis: 'browser-runtime',
            technologyKey: 'lighthouse',
            source: 'lighthouse',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: ['separate-navigation-experiment'],
        }
    )
    report.lighthouse.metrics = [
        metric({
            family: 'lighthouse',
            name: 'FCP',
            stat: 'latest',
            unit: 'ms',
            value: 1_200,
            samples: 1,
            metricId: 'lighthouse.fcp.latest',
        }),
    ]
    report.findings = []
    return report
}

function slowFrameMetric(overrides: Record<string, unknown> = {}) {
    return expandedMetric({
        family: 'frameCadence',
        name: 'slowFrameRate',
        stat: 'ratio',
        unit: 'ratio',
        value: 0.2,
        metricId: 'frame.slow-rate',
        budgetRefs: [],
        ...overrides,
    })
}

function realisticLargeAnimationReportV2() {
    const report = animationReportV2()
    const actions = Array.from({ length: 72 }, (_, index) => ({
        actionId: `action-${index.toString().padStart(3, '0')}`,
        order: index,
        kind: 'wait',
        label: `action-label-${index.toString().padStart(3, '0')}`,
        subject: {
            scope: 'subject',
            subjectKey: `subject-${index.toString().padStart(3, '0')}`,
            role: 'region',
            surface: 'dom',
        },
        trigger: { source: 'scenario' },
    }))
    const windows = actions.map((action, index) => ({
        actionId: action.actionId,
        order: index,
        kind: 'wait',
        trigger: { source: 'scenario' },
        subject: action.subject,
        outcome: { status: 'completed' },
        timestamps: {
            clock: 'attempt-monotonic',
            startedAtMs: 100 + index * 10,
            endedAtMs: 105 + index * 10,
            durationMs: 5,
        },
        evidenceRefs: ['runtime-browser'],
        limitations: [],
    }))
    const actionEvidenceLimitations = ['action-window-overlap-is-correlative']
    const actionLimitations = [...actionEvidenceLimitations, 'eligible-attempts-1', 'total-attempts-1']
    const attemptActionMetrics = actions.flatMap(action => [
        expandedMetric({
            scope: { level: 'action', attemptId: 'attempt_1', actionId: action.actionId },
            aggregation: { population: 'frames', method: 'nearest-rank' },
            budgetRefs: [],
            limitations: actionEvidenceLimitations,
        }),
        slowFrameMetric({
            scope: { level: 'action', attemptId: 'attempt_1', actionId: action.actionId },
            aggregation: { population: 'frames', method: 'ratio' },
            limitations: actionEvidenceLimitations,
        }),
    ])
    const aggregateActionMetrics = actions.flatMap(action => [
        expandedMetric({
            scope: { level: 'action', actionId: action.actionId },
            budgetRefs: [],
            limitations: actionLimitations,
        }),
        slowFrameMetric({
            scope: { level: 'action', actionId: action.actionId },
            limitations: actionLimitations,
        }),
    ])
    report.scenario.actions = actions
    report.scenario.actionLabels = actions.map(action => action.label)
    report.attempts[0]!.metrics = [
        expandedMetric({
            scope: { level: 'attempt', attemptId: 'attempt_1' },
            aggregation: { population: 'frames', method: 'nearest-rank' },
            limitations: [],
        }),
        ...attemptActionMetrics,
    ]
    report.attempts[0]!.actionWindows = windows
    report.aggregateMetrics = [expandedMetric(), ...aggregateActionMetrics]
    report.actionWindows = windows
    report.findings = []
    return report
}

function oversizedLegacySummaryReport() {
    const report = animationReport()
    report.aggregateMetrics = Array.from({ length: 256 }, (_, index) =>
        metric({
            family: `family${index.toString().padStart(3, '0')}${'f'.repeat(68)}`,
            name: `metric${index.toString().padStart(3, '0')}${'m'.repeat(68)}`,
        })
    )
    return report
}

describe('lab platform artifact projections', () => {
    it('maps a bounded redacted trace-index to the frontend timeline contract', () => {
        expect(parseTraceIndexArtifact(traceIndex())).toEqual(
            expect.objectContaining({
                durationMs: 100,
                totalEvents: 1,
                truncated: false,
                maxEvents: LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
                events: [
                    expect.objectContaining({
                        eventId: 'trace-0',
                        category: 'long-task',
                        lane: 'main',
                        severity: 'warning',
                        attributes: { thread: 'main', selfTimeMs: 30, actionLabel: 'hover-card' },
                    }),
                ],
            })
        )
    })

    it('rejects oversized timeline indexes instead of silently truncating them', () => {
        const events = Array.from({ length: LAB_PLATFORM_TIMELINE_EVENT_LIMIT + 1 }, (_, index) => traceEvent(index))
        expect(() => parseTraceIndexArtifact(traceIndex(events))).toThrow(PayloadTooLargeException)
    })

    it('accepts fixed opaque-source sentinels but rejects origin-bearing stack sources', () => {
        const redacted = traceEvent()
        redacted.stack[0]!.source = 'blob:[redacted]'
        expect(parseTraceIndexArtifact(traceIndex([redacted])).events[0]?.stack[0]?.fileName).toBe('blob:[redacted]')

        const unsafe = traceEvent()
        unsafe.stack[0]!.source = 'blob:http://localhost:5173/private-id'
        expect(() => parseTraceIndexArtifact(traceIndex([unsafe]))).toThrow(BadRequestException)
    })

    it('projects only bounded, privacy-safe animation report fields', () => {
        const parsed = parseAnimationReportArtifact(animationReport())
        expect(parsed.analysis).toBeNull()
        expect(parsed.context).toEqual(
            expect.objectContaining({
                durationMs: 12_000,
                environment: 'development',
                browser: 'chromium 140.0.0',
                viewport: { width: 1280, height: 720, dpr: 1 },
            })
        )
        expect(parsed.lighthouse).toEqual(
            expect.objectContaining({
                version: '13.0.0',
                requestedUrl: null,
                finalUrl: null,
                categories: expect.arrayContaining([expect.objectContaining({ id: 'performance', score: 0.92 })]),
                failedAudits: [expect.objectContaining({ id: 'unused-javascript', score: 0.5 })],
            })
        )
        expect(parsed.compactSummary.lighthouse?.scores?.performance).toBe(0.92)
        expect(parsed.compactSummary.metrics?.[0]).toEqual(expect.objectContaining({ evidenceLevel: 'controlled-lab-measurement' }))
    })

    it('retains and verifies the executed platform envelope against actual attempt structure', () => {
        const legacy = animationReport()
        const { lighthouse, ...withoutLighthouse } = legacy
        expect(lighthouse).toBeDefined()
        const execution = {
            warmupRuns: 0,
            measuredRuns: 3,
            durationMs: 5_000,
            trace: false,
            lighthouse: false,
            colorScheme: 'light',
            cpuThrottleRate: 1,
            network: null,
        }
        const report = {
            ...withoutLighthouse,
            scenario: { ...legacy.scenario, execution },
            attempts: Array.from({ length: 3 }, (_, index) => ({
                ...legacy.attempts[0],
                attemptId: `attempt_${index}`,
                index,
                observationDurationMs: 5_000,
            })),
        }

        expect(parseAnimationReportArtifact(report).context.execution).toEqual(execution)

        const drift = structuredClone(report)
        drift.scenario.execution.measuredRuns = 4
        expect(() => parseAnimationReportArtifact(drift)).toThrow('attempts do not match')

        const tooShort = structuredClone(report)
        tooShort.attempts[0].observationDurationMs = 4_000
        expect(() => parseAnimationReportArtifact(tooShort)).toThrow('shorter than the declared observation duration')

        const impossibleObservation = structuredClone(report)
        impossibleObservation.attempts[0].observationDurationMs = 10_002
        expect(() => parseAnimationReportArtifact(impossibleObservation)).toThrow('observationDurationMs cannot exceed durationMs')

        const inconsistentClock = structuredClone(report)
        inconsistentClock.attempts[0].durationMs = 7_000
        expect(() => parseAnimationReportArtifact(inconsistentClock)).toThrow('timestamps do not match durationMs')

        const undeclaredTimeline = { ...structuredClone(report), timeline: traceIndex() }
        expect(() => parseAnimationReportArtifact(undeclaredTimeline)).toThrow('timeline does not match an executed CDP Trace')

        const undeclaredLighthouse = { ...structuredClone(report), lighthouse: legacy.lighthouse }
        expect(() => parseAnimationReportArtifact(undeclaredLighthouse)).toThrow(
            'Lighthouse result does not match an executed Lighthouse attempt'
        )

        const missingLighthouseResult = structuredClone(report)
        missingLighthouseResult.scenario.execution.lighthouse = true
        ;(missingLighthouseResult.attempts as unknown as Array<Record<string, unknown>>).push({
            attemptId: 'lighthouse_success',
            phase: 'lighthouse',
            index: 0,
            startedAt: '2026-08-25T00:00:11.000Z',
            endedAt: '2026-08-25T00:00:11.000Z',
            durationMs: 0,
            metrics: [],
            capabilities: { lighthouse: true, chromium: true },
            limitations: [],
        })
        expect(() => parseAnimationReportArtifact(missingLighthouseResult)).toThrow(
            'Lighthouse result does not match an executed Lighthouse attempt'
        )
    })

    it.each(['firefox', 'webkit'])('accepts a zero-duration unsupported trace attempt from %s', browserName => {
        const legacy = animationReport()
        const { lighthouse, ...withoutLighthouse } = legacy
        expect(lighthouse).toBeDefined()
        const execution = {
            warmupRuns: 0,
            measuredRuns: 3,
            durationMs: 5_000,
            trace: true,
            lighthouse: false,
            colorScheme: 'light',
            cpuThrottleRate: 1,
            network: null,
        }
        const measured = Array.from({ length: 3 }, (_, index) => ({
            ...legacy.attempts[0],
            attemptId: `attempt_${index}`,
            index,
            observationDurationMs: 5_000,
        }))
        const unavailableTrace = {
            attemptId: 'trace-unavailable',
            phase: 'diagnostic-trace',
            index: 0,
            startedAt: '2026-08-25T00:00:11.000Z',
            endedAt: '2026-08-25T00:00:11.000Z',
            durationMs: 0,
            metrics: [],
            capabilities: { cdpTrace: false, cpuProfile: false, screenshots: false },
            limitations: [`cdp-trace-unavailable-browser-${browserName}`],
        }
        const report = {
            ...withoutLighthouse,
            browser: { name: browserName, version: 'test', headless: true },
            scenario: { ...legacy.scenario, execution },
            attempts: [...measured, unavailableTrace],
        }

        expect(parseAnimationReportArtifact(report).context).toEqual(expect.objectContaining({ browserName, execution }))

        const forgedUnsupportedTrace = structuredClone(report)
        ;(forgedUnsupportedTrace.attempts as unknown as Array<Record<string, unknown>>)[3] = {
            ...unavailableTrace,
            endedAt: '2026-08-25T00:00:11.100Z',
            durationMs: 100,
            metrics: [metric()],
        }
        expect(() => parseAnimationReportArtifact(forgedUnsupportedTrace)).toThrow('empty zero-duration diagnostic')

        const falseMeasuredTrace = structuredClone(report)
        falseMeasuredTrace.attempts[3] = {
            ...unavailableTrace,
            capabilities: { ...unavailableTrace.capabilities, cdpTrace: true },
        }
        expect(() => parseAnimationReportArtifact(falseMeasuredTrace)).toThrow('shorter than the declared observation duration')
    })

    it('accepts the maximum platform execution envelope within the two-hour runner grant window', () => {
        const legacy = animationReport()
        const { lighthouse, ...base } = legacy
        expect(lighthouse).toBeDefined()
        const startedAt = '2026-08-25T00:00:00.000Z'
        const endedAt = '2026-08-25T01:40:00.000Z'
        const pageAttempt = (phase: 'warmup' | 'measured', index: number) => ({
            ...legacy.attempts[0],
            attemptId: `${phase}_${index}`,
            phase,
            index,
            startedAt,
            endedAt: '2026-08-25T00:02:00.000Z',
            durationMs: 120_000,
            observationDurationMs: 120_000,
        })
        const report = {
            ...base,
            browser: { name: 'firefox', version: 'test', headless: true },
            startedAt,
            endedAt,
            scenario: {
                ...legacy.scenario,
                cacheMode: 'warm',
                execution: {
                    warmupRuns: 5,
                    measuredRuns: 20,
                    durationMs: 120_000,
                    trace: true,
                    lighthouse: true,
                    colorScheme: 'light',
                    cpuThrottleRate: 1,
                    network: null,
                },
            },
            attempts: [
                ...Array.from({ length: 5 }, (_, index) => pageAttempt('warmup', index)),
                ...Array.from({ length: 20 }, (_, index) => pageAttempt('measured', index)),
                {
                    attemptId: 'trace_unavailable',
                    phase: 'diagnostic-trace',
                    index: 0,
                    startedAt: endedAt,
                    endedAt,
                    durationMs: 0,
                    metrics: [],
                    capabilities: { cdpTrace: false, cpuProfile: false, screenshots: false },
                    limitations: ['cdp-trace-unavailable-browser-firefox'],
                },
                {
                    attemptId: 'lighthouse_unavailable',
                    phase: 'lighthouse',
                    index: 0,
                    startedAt: endedAt,
                    endedAt,
                    durationMs: 0,
                    metrics: [],
                    capabilities: { lighthouse: false, chromium: false },
                    limitations: ['lighthouse-unavailable-browser-firefox'],
                },
            ],
        }

        expect(parseAnimationReportArtifact(report).context.durationMs).toBe(6_000_000)

        const forgedUnavailableLighthouse = structuredClone(report)
        const unavailableLighthouse = (forgedUnavailableLighthouse.attempts as unknown as Array<Record<string, unknown>>)[26]!
        unavailableLighthouse.endedAt = '2026-08-25T01:40:00.100Z'
        unavailableLighthouse.durationMs = 100
        unavailableLighthouse.metrics = [metric()]
        expect(() => parseAnimationReportArtifact(forgedUnavailableLighthouse)).toThrow('empty zero-duration diagnostic')

        const beyondGrant = structuredClone(report)
        beyondGrant.endedAt = '2026-08-25T02:00:00.001Z'
        expect(() => parseAnimationReportArtifact(beyondGrant)).toThrow('duration is too large')
    })

    it('keeps canonical v2 evidence in raw analysis while persisting only the base run summary shape', () => {
        const report = animationReportV2()
        Object.assign(report.scenario, { protocolHash: 'a'.repeat(64) })
        const parsed = parseAnimationReportArtifact(report)

        expect(parsed.analysis).toEqual(
            expect.objectContaining({
                semanticsVersion: 2,
                scenarioActions: [expect.objectContaining({ actionId: 'hero-hover-01', kind: 'hover' })],
                actionWindows: [expect.objectContaining({ actionId: 'hero-hover-01', outcome: { status: 'completed' } })],
                metrics: [
                    expect.objectContaining({
                        metricId: 'frame.duration.p95',
                        evidenceLevel: 'controlled-lab-measurement',
                        scope: { level: 'run' },
                        aggregation: { population: 'attempts', method: 'median-of-attempts' },
                    }),
                ],
                technologyEvidence: [expect.objectContaining({ evidenceId: 'runtime-browser' })],
                findings: [],
            })
        )
        expect(parsed.compactSummary.metrics?.[0]).toEqual({
            family: 'frameCadence',
            name: 'frameDurationMs',
            stat: 'p95',
            unit: 'ms',
            value: 18.4,
            samples: 120,
            status: 'partial',
            evidenceLevel: 'controlled-lab-measurement',
        })
        expect(parsed.compactSummary.metrics?.[0]).not.toHaveProperty('metricId')
        expect(parsed.context).toEqual(
            expect.objectContaining({
                routeKey: 'examples.hover-card',
                scenarioProtocolHash: 'a'.repeat(64),
                browserVersion: '140.0.0',
            })
        )
        expect(parsed.measuredAttempts).toEqual([
            expect.objectContaining({
                attemptId: 'attempt_1',
                metrics: [expect.objectContaining({ metricId: 'frame.duration.p95', scope: { level: 'attempt', attemptId: 'attempt_1' } })],
                capabilities: expect.objectContaining({ longtask: true }),
                limitations: [],
            }),
        ])

        const forgedProtocol = animationReportV2()
        Object.assign(forgedProtocol.scenario, { protocolHash: 'A'.repeat(64) })
        expect(() => parseAnimationReportArtifact(forgedProtocol)).toThrow('Invalid animation-report.scenario.protocolHash')
    })

    it('accepts a complete budget-v2 zero-event Long Task report without changing the compact summary shape', () => {
        const parsed = parseAnimationReportArtifact(completeZeroLongTaskReportV2())

        expect(parsed.analysis?.measurementContract.budgetRef.budgetVersion).toBe(2)
        expect(parsed.analysis?.metrics).toEqual([
            expect.objectContaining({
                metricId: 'main.long-task.count',
                value: 0,
                samples: 0,
                status: 'measured',
                budgetRefs: [expect.objectContaining({ budgetVersion: 2, ruleId: 'long-task-count' })],
            }),
        ])
        expect(parsed.analysis?.findings).toEqual([])
        expect(parsed.measuredAttempts).toHaveLength(3)
        expect(parsed.measuredAttempts.every(attempt => attempt.capabilities.longtask === true)).toBe(true)
        expect(parsed.compactSummary.metrics?.[0]).not.toHaveProperty('metricId')
        expect(parsed.compactSummary.metrics?.[0]).not.toHaveProperty('budgetRefs')
    })

    it('preserves opaque budget references and rejects mixed references or mismatched canonical rules', () => {
        const unknownVersion = setReportBudgetVersion(completeZeroLongTaskReportV2(), 4)
        const parsedUnknownVersion = parseAnimationReportArtifact(unknownVersion)
        expect(parsedUnknownVersion.analysis?.measurementContract.budgetRef.budgetVersion).toBe(4)
        expect(parsedUnknownVersion.analysis?.metrics[0]?.budgetRefs[0]?.budgetVersion).toBe(4)

        const unknownId = completeZeroLongTaskReportV2()
        unknownId.measurementContract.budgetRef.budgetId = 'unknown-budget'
        for (const attempt of unknownId.attempts) {
            for (const metric of attempt.metrics) {
                for (const ref of metric.budgetRefs) ref.budgetId = 'unknown-budget'
            }
        }
        for (const metric of unknownId.aggregateMetrics) {
            for (const ref of metric.budgetRefs) ref.budgetId = 'unknown-budget'
        }
        const parsedUnknownId = parseAnimationReportArtifact(unknownId)
        expect(parsedUnknownId.analysis?.measurementContract.budgetRef.budgetId).toBe('unknown-budget')
        expect(parsedUnknownId.analysis?.metrics[0]?.budgetRefs[0]?.budgetId).toBe('unknown-budget')

        const mixedMetric = completeZeroLongTaskReportV2()
        mixedMetric.aggregateMetrics[0]!.budgetRefs[0]!.budgetVersion = 1
        expect(() => parseAnimationReportArtifact(mixedMetric)).toThrow('budgetRef conflicts with measurementContract')

        const mixedAttempt = completeZeroLongTaskReportV2()
        mixedAttempt.attempts[0]!.metrics[0]!.budgetRefs[0]!.budgetVersion = 1
        expect(() => parseAnimationReportArtifact(mixedAttempt)).toThrow('budgetRef conflicts with measurementContract')

        const reverseMixedMetric = completeZeroLongTaskReportV2()
        reverseMixedMetric.measurementContract.budgetRef.budgetVersion = 1
        expect(() => parseAnimationReportArtifact(reverseMixedMetric)).toThrow('budgetRef conflicts with measurementContract')

        const unknownRule = completeZeroLongTaskReportV2()
        unknownRule.aggregateMetrics[0]!.budgetRefs[0]!.ruleId = 'unknown-rule'
        expect(() => parseAnimationReportArtifact(unknownRule)).toThrow('unknown canonical budget rule')

        const wrongMetric = completeZeroLongTaskReportV2()
        wrongMetric.aggregateMetrics[0]!.budgetRefs[0]!.ruleId = 'frame-tail'
        expect(() => parseAnimationReportArtifact(wrongMetric)).toThrow('budget rule does not apply to metricId')

        const mixedFinding = candidateFrameTailReportV2()
        mixedFinding.measurementContract.budgetRef.budgetVersion = 2
        for (const attempt of mixedFinding.attempts) {
            for (const metric of attempt.metrics) {
                for (const ref of metric.budgetRefs) ref.budgetVersion = 2
            }
        }
        for (const metric of mixedFinding.aggregateMetrics) {
            for (const ref of metric.budgetRefs) ref.budgetVersion = 2
        }
        expect(() => parseAnimationReportArtifact(mixedFinding)).toThrow('budgetRef conflicts with measurementContract')

        const wrongFindingRule = candidateFrameTailReportV2()
        wrongFindingRule.findings[0]!.ruleId = 'slow-frame-rate'
        expect(() => parseAnimationReportArtifact(wrongFindingRule)).toThrow('ruleId conflicts with budgetRef')

        const wrongFindingMetric = candidateFrameTailReportV2()
        wrongFindingMetric.findings[0]!.ruleId = 'long-task-count'
        wrongFindingMetric.findings[0]!.budgetRefs[0]!.ruleId = 'long-task-count'
        expect(() => parseAnimationReportArtifact(wrongFindingMetric)).toThrow('budget rule does not apply to metricIds')
    })

    it('requires findings to match the canonical budget evaluation', () => {
        const underBudget = animationReportV2()
        underBudget.findings = []
        expect(parseAnimationReportArtifact(underBudget).analysis?.findings).toEqual([])

        const invented = animationReportV2()
        invented.findings = [frameTailFinding()]
        expect(() => parseAnimationReportArtifact(invented)).toThrow('canonical budget evaluation')

        const candidate = candidateFrameTailReportV2()
        expect(parseAnimationReportArtifact(candidate).analysis?.findings).toEqual(candidate.findings)

        const critical = candidateFrameTailReportV2(60)
        expect(parseAnimationReportArtifact(critical).analysis?.findings[0]).toEqual(expect.objectContaining({ severity: 'critical' }))

        const observed = observedLongTaskReportV2()
        expect(parseAnimationReportArtifact(observed).analysis?.findings[0]).toEqual(
            expect.objectContaining({ findingId: 'finding-long-task-count-run-all', status: 'observed', severity: 'warning' })
        )

        const omitted = candidateFrameTailReportV2()
        omitted.findings = []
        expect(() => parseAnimationReportArtifact(omitted)).toThrow('canonical budget evaluation')

        const omittedObserved = observedLongTaskReportV2()
        omittedObserved.findings = []
        expect(() => parseAnimationReportArtifact(omittedObserved)).toThrow('canonical budget evaluation')

        const unknownBudgetFinding = setReportBudgetVersion(candidateFrameTailReportV2(), 5)
        expect(() => parseAnimationReportArtifact(unknownBudgetFinding)).toThrow('canonical budget evaluation')

        const actionCandidate = candidateFrameTailReportV2()
        Object.assign(actionCandidate.attempts[0]!.metrics[0]!.scope, {
            level: 'action',
            attemptId: 'attempt_1',
            actionId: 'hero-hover-01',
        })
        Object.assign(actionCandidate.aggregateMetrics[0]!.scope, { level: 'action', actionId: 'hero-hover-01' })
        actionCandidate.findings = [
            frameTailFinding({
                findingId: 'finding-frame-tail-action-hero-hover-01',
                scope: { level: 'action', actionId: 'hero-hover-01' },
                actionIds: ['hero-hover-01'],
            }),
        ]
        expect(parseAnimationReportArtifact(actionCandidate).analysis?.findings).toEqual(actionCandidate.findings)

        for (const mutate of [
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.severity = 'critical'),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.status = 'observed'),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.findingId = 'caller-authored-id'),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.metricIds = []),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.evidenceRefs = []),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.actionIds = ['hero-hover-01']),
            (report: ReturnType<typeof candidateFrameTailReportV2>) => void (report.findings[0]!.limitations = []),
        ]) {
            const forged = candidateFrameTailReportV2()
            mutate(forged)
            expect(() => parseAnimationReportArtifact(forged)).toThrow(BadRequestException)
        }
    })

    it('validates the closed v3 rule map while keeping v1 and v2 identities unchanged', () => {
        const validV3 = setReportBudgetVersion(completeZeroLongTaskReportV2(), 3)
        const parsed = parseAnimationReportArtifact(validV3)
        expect(parsed.analysis?.measurementContract.budgetRef.budgetVersion).toBe(3)
        expect(parsed.analysis?.metrics[0]?.budgetRefs[0]).toEqual(expect.objectContaining({ budgetVersion: 3, ruleId: 'long-task-count' }))

        const forgedV3Metric = setReportBudgetVersion(completeZeroLongTaskReportV2(), 3)
        forgedV3Metric.aggregateMetrics[0]!.budgetRefs[0]!.ruleId = 'loaf-count'
        expect(() => parseAnimationReportArtifact(forgedV3Metric)).toThrow('budget rule does not apply to metricId')

        const forgedV3Rule = setReportBudgetVersion(completeZeroLongTaskReportV2(), 3)
        forgedV3Rule.aggregateMetrics[0]!.budgetRefs[0]!.ruleId = 'unknown-rule'
        expect(() => parseAnimationReportArtifact(forgedV3Rule)).toThrow('unknown canonical budget rule')

        const forgedV2Rule = completeZeroLongTaskReportV2()
        forgedV2Rule.aggregateMetrics[0]!.budgetRefs[0]!.ruleId = 'loaf-count'
        expect(() => parseAnimationReportArtifact(forgedV2Rule)).toThrow('unknown canonical budget rule')

        const forgedV3Finding = setReportBudgetVersion(candidateFrameTailReportV2(), 3)
        forgedV3Finding.findings[0]!.ruleId = 'loaf-count'
        forgedV3Finding.findings[0]!.budgetRefs[0]!.ruleId = 'loaf-count'
        expect(() => parseAnimationReportArtifact(forgedV3Finding)).toThrow('budget rule does not apply to metricIds')
    })

    it('accepts exact run-scope Trace and Lighthouse projections and rejects forged diagnostic aggregates', () => {
        const report = diagnosticProjectionReportV3()
        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.metrics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    metricId: 'trace.script.duration',
                    scope: { level: 'run' },
                    aggregation: { population: 'events', method: 'sum' },
                    evidenceRefs: ['cdp-trace'],
                }),
                expect.objectContaining({
                    metricId: 'lighthouse.fcp.latest',
                    scope: { level: 'run' },
                    aggregation: { population: 'latest', method: 'latest' },
                    evidenceRefs: ['lighthouse'],
                }),
            ])
        )

        const breachedLighthouse = diagnosticProjectionReportV3()
        const breachedAttemptMetric = breachedLighthouse.attempts
            .find(attempt => attempt.phase === 'lighthouse')!
            .metrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!
        const breachedAggregateMetric = breachedLighthouse.aggregateMetrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!
        breachedAttemptMetric.value = 2_000
        breachedAggregateMetric.value = 2_000
        breachedLighthouse.lighthouse.metrics[0]!.value = 2_000
        breachedLighthouse.findings = [
            {
                findingId: 'finding-lighthouse-first-contentful-paint-run-all',
                ruleId: 'lighthouse-first-contentful-paint',
                severity: 'warning',
                status: 'observed',
                scope: { level: 'run' },
                metricIds: ['lighthouse.fcp.latest'],
                evidenceRefs: ['lighthouse'],
                budgetRefs: [
                    {
                        catalogVersion: 1,
                        budgetId: 'condev.animation.default',
                        budgetVersion: 3,
                        ruleId: 'lighthouse-first-contentful-paint',
                    },
                ],
                actionIds: [],
                limitations: [
                    'separate-navigation-experiment',
                    'lighthouse-form-factor-desktop',
                    'lighthouse-isolated-process-does-not-inherit-measured-cache',
                    'diagnostic-project-budget-not-web-standard',
                ],
            },
        ]
        expect(parseAnimationReportArtifact(breachedLighthouse).analysis?.findings).toEqual(breachedLighthouse.findings)

        const omittedLighthouseFinding = diagnosticProjectionReportV3()
        omittedLighthouseFinding.attempts
            .find(attempt => attempt.phase === 'lighthouse')!
            .metrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!.value = 2_000
        omittedLighthouseFinding.aggregateMetrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!.value = 2_000
        omittedLighthouseFinding.lighthouse.metrics[0]!.value = 2_000
        expect(() => parseAnimationReportArtifact(omittedLighthouseFinding)).toThrow('canonical budget evaluation')

        const forgedValue = diagnosticProjectionReportV3()
        forgedValue.aggregateMetrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!.value = 1_201
        expect(() => parseAnimationReportArtifact(forgedValue)).toThrow('conflicts with its lighthouse attempt')

        const forgedEvidence = diagnosticProjectionReportV3()
        forgedEvidence.aggregateMetrics.find(metric => metric.metricId === 'trace.script.duration')!.evidenceRefs = ['runtime-browser']
        expect(() => parseAnimationReportArtifact(forgedEvidence)).toThrow('conflicts with its diagnostic-trace attempt')

        const missingSource = diagnosticProjectionReportV3()
        missingSource.attempts.find(attempt => attempt.phase === 'diagnostic-trace')!.metrics = []
        expect(() => parseAnimationReportArtifact(missingSource)).toThrow('requires one matching diagnostic-trace metric')

        const narrowedScope = diagnosticProjectionReportV3()
        const narrowedTrace = narrowedScope.aggregateMetrics.find(metric => metric.metricId === 'trace.script.duration') as Record<
            string,
            unknown
        >
        narrowedTrace.scope = {
            level: 'action',
            actionId: 'hero-hover-01',
        }
        narrowedTrace.aggregation = { population: 'attempts', method: 'median-of-attempts' }
        expect(() => parseAnimationReportArtifact(narrowedScope)).toThrow('diagnostic projection must use run scope')

        const forgedAggregation = diagnosticProjectionReportV3()
        const aggregateLighthouse = forgedAggregation.aggregateMetrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!
        const attemptLighthouse = forgedAggregation.attempts
            .find(attempt => attempt.phase === 'lighthouse')!
            .metrics.find(metric => metric.metricId === 'lighthouse.fcp.latest')!
        aggregateLighthouse.aggregation = { population: 'events', method: 'sum' }
        attemptLighthouse.aggregation = { population: 'events', method: 'sum' }
        expect(() => parseAnimationReportArtifact(forgedAggregation)).toThrow('conflicts with its lighthouse attempt')
    })

    it('keeps a real-scale action catalog in raw analysis without overflowing the persisted summary', () => {
        const report = realisticLargeAnimationReportV2()
        expect(report.aggregateMetrics).toHaveLength(145)
        expect(Buffer.byteLength(JSON.stringify({ metrics: report.aggregateMetrics }), 'utf8')).toBeGreaterThan(LAB_RUN_SUMMARY_MAX_BYTES)

        const first = parseAnimationReportArtifact(report)
        const second = parseAnimationReportArtifact(realisticLargeAnimationReportV2())

        expect(first.analysis?.metrics).toHaveLength(145)
        expect(first.analysis?.metrics.filter(item => item.scope.level === 'action')).toHaveLength(144)
        expect(first.compactSummary.metrics).toHaveLength(1)
        expect(first.compactSummary.metrics?.[0]).not.toHaveProperty('metricId')
        expect(first.compactSummary.limitations).toContain(LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED)
        expect(first.compactSummary.limitations).not.toContain(LAB_COMPACT_SUMMARY_METRICS_TRUNCATED)
        expect(Buffer.byteLength(JSON.stringify(first.compactSummary), 'utf8')).toBeLessThanOrEqual(LAB_RUN_SUMMARY_MAX_BYTES)
        expect(() => parseLabRunSummary(first.compactSummary)).not.toThrow()
        expect(second.compactSummary).toEqual(first.compactSummary)
    })

    it('deterministically truncates an oversized legacy summary at whole-metric boundaries', () => {
        const report = oversizedLegacySummaryReport()
        expect(Buffer.byteLength(JSON.stringify({ metrics: report.aggregateMetrics }), 'utf8')).toBeGreaterThan(LAB_RUN_SUMMARY_MAX_BYTES)

        const first = parseAnimationReportArtifact(report).compactSummary
        const second = parseAnimationReportArtifact(structuredClone(report)).compactSummary

        expect(first.metrics?.length).toBeGreaterThan(0)
        expect(first.metrics?.length).toBeLessThan(256)
        expect(first.limitations).toContain(LAB_COMPACT_SUMMARY_METRICS_TRUNCATED)
        expect(first.limitations).not.toContain(LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED)
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(LAB_RUN_SUMMARY_MAX_BYTES)
        expect(() => parseLabRunSummary(first)).not.toThrow()
        expect(second).toEqual(first)
    })

    it('accepts additive catalog v2 metrics while keeping the v1 catalog closed', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        report.attempts[0]!.metrics = [
            loafPaintMetric({
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'frames', method: 'nearest-rank' },
                limitations: [],
            }),
        ]
        report.aggregateMetrics = [loafPaintMetric()]
        report.findings = []

        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.measurementContract.metricCatalogVersion).toBe(2)
        expect(parsed.analysis?.metrics).toEqual([
            expect.objectContaining({
                metricId: 'pipeline.loaf-render-start-to-paint.p95',
                name: 'longAnimationFrameRenderStartToPaintMs',
            }),
        ])

        const forgedV1 = animationReportV2()
        forgedV1.attempts[0]!.metrics = [
            loafPaintMetric({
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'frames', method: 'nearest-rank' },
                limitations: [],
            }),
        ]
        forgedV1.aggregateMetrics = [loafPaintMetric()]
        forgedV1.findings = []
        expect(() => parseAnimationReportArtifact(forgedV1)).toThrow('requires metric catalog v2')
    })

    it('accepts catalog v3 action-window video deltas while keeping catalog v2 closed', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 3
        Object.assign(report.attempts[0]!.capabilities, { videoPlaybackQuality: true })
        report.attempts[0]!.metrics = [
            videoWindowMetric({
                scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
                aggregation: { population: 'media-frames', method: 'ratio' },
                limitations: [
                    'video-playback-quality-window-counter-delta',
                    'video-playback-quality-total-includes-displayed-and-dropped',
                    'video-playback-quality-window-object-identity-only',
                    'video-playback-quality-not-decode-presentation-or-gpu-timing',
                ],
            }),
        ]
        report.aggregateMetrics = [videoWindowMetric()]
        report.findings = []

        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.measurementContract.metricCatalogVersion).toBe(3)
        expect(parsed.analysis?.metrics).toEqual([
            expect.objectContaining({
                metricId: 'media.video-window-dropped-frame-rate',
                name: 'videoWindowDroppedFrameRate',
                scope: { level: 'action', actionId: 'hero-hover-01' },
            }),
        ])
        expect(parsed.compactSummary.limitations).toContain(LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED)

        const forgedV2 = animationReportV2()
        forgedV2.measurementContract.metricCatalogVersion = 2
        forgedV2.attempts[0]!.metrics = [
            videoWindowMetric({
                scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
                aggregation: { population: 'media-frames', method: 'ratio' },
            }),
        ]
        forgedV2.aggregateMetrics = [videoWindowMetric()]
        forgedV2.findings = []
        expect(() => parseAnimationReportArtifact(forgedV2)).toThrow('requires metric catalog v3')
    })

    it('accepts catalog v4 renderer evidence and evaluates the canonical GPU budget', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 4
        report.measurementContract.budgetRef.budgetVersion = 4
        const sourceAttempt = report.attempts[0]!
        report.attempts = Array.from({ length: 3 }, (_, index) => {
            const attemptId = `attempt_${index + 1}`
            return {
                ...sourceAttempt,
                attemptId,
                index,
                capabilities: { ...sourceAttempt.capabilities, rendererEvidenceBridge: true },
                metrics: (['renderer.draw-calls.p95', 'renderer.triangles.p95', 'renderer.gpu-frame.p95'] as const).map(metricId =>
                    rendererMetric(metricId, {
                        scope: { level: 'attempt', attemptId },
                        aggregation: { population: 'samples', method: 'nearest-rank' },
                        status: 'measured',
                        limitations: [
                            metricId === 'renderer.gpu-frame.p95' ? 'renderer-host-gpu-query-p95' : 'renderer-host-sample-p95',
                            'renderer-multiple-producers-not-distinguished',
                            ...(metricId === 'renderer.gpu-frame.p95' ? ['renderer-gpu-action-window-not-proven'] : []),
                        ],
                    })
                ),
                actionWindows: [actionWindow()],
            }
        })
        report.aggregateMetrics = (['renderer.draw-calls.p95', 'renderer.triangles.p95', 'renderer.gpu-frame.p95'] as const).map(metricId =>
            rendererMetric(metricId, { status: 'measured', samples: 90 })
        )
        report.technologyEvidence.push({
            evidenceId: 'lab-renderer-adapter',
            axis: 'renderer',
            technologyKey: 'condev-lab-renderer-evidence',
            source: 'host-adapter',
            confidence: 'high',
            status: 'observed',
            scope: { level: 'run' },
            limitations: [
                'renderer-adapter-identity-not-retained',
                'renderer-multiple-producers-not-distinguished',
                'renderer-evidence-is-page-level',
            ],
        } as unknown as (typeof report.technologyEvidence)[number])
        report.findings = [
            {
                findingId: 'finding-renderer-gpu-frame-tail-run-all',
                ruleId: 'renderer-gpu-frame-tail',
                severity: 'warning',
                status: 'observed',
                scope: { level: 'run' },
                metricIds: ['renderer.gpu-frame.p95'],
                evidenceRefs: ['lab-renderer-adapter'],
                budgetRefs: [
                    {
                        catalogVersion: 1,
                        budgetId: 'condev.animation.default',
                        budgetVersion: 4,
                        ruleId: 'renderer-gpu-frame-tail',
                    },
                ],
                actionIds: [],
                limitations: [
                    'renderer-host-gpu-query-p95',
                    'renderer-multiple-producers-not-distinguished',
                    'renderer-gpu-action-window-not-proven',
                    'eligible-attempts-3',
                    'total-attempts-3',
                    'diagnostic-project-budget-not-web-standard',
                ],
            },
        ]

        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.measurementContract.metricCatalogVersion).toBe(4)
        expect(parsed.analysis?.metrics.map(item => item.metricId)).toEqual([
            'renderer.draw-calls.p95',
            'renderer.triangles.p95',
            'renderer.gpu-frame.p95',
        ])
        expect(parsed.analysis?.findings).toEqual([expect.objectContaining({ ruleId: 'renderer-gpu-frame-tail', status: 'observed' })])

        const forgedV3 = JSON.parse(JSON.stringify(report)) as typeof report
        forgedV3.measurementContract.metricCatalogVersion = 3
        expect(() => parseAnimationReportArtifact(forgedV3)).toThrow('requires metric catalog v4')

        const actionGpu = JSON.parse(JSON.stringify(report)) as typeof report
        Object.assign(actionGpu.attempts[0]!.metrics[2]!, {
            scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
        })
        expect(() => parseAnimationReportArtifact(actionGpu)).toThrow('cannot attribute GPU timing to an action window')
    })

    it('binds catalog v3 video-window evidence to every measured attempt capability', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 3
        report.attempts[0]!.metrics = [
            videoWindowMetric({
                scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
                aggregation: { population: 'media-frames', method: 'ratio' },
            }),
        ]
        report.aggregateMetrics = [videoWindowMetric()]
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow('missing videoPlaybackQuality capability')

        Object.assign(report.attempts[0]!.capabilities, { videoPlaybackQuality: false })
        expect(() => parseAnimationReportArtifact(report)).toThrow('videoPlaybackQuality capability conflicts')

        Object.assign(report.attempts[0]!.capabilities, { videoPlaybackQuality: true })
        expect(() => parseAnimationReportArtifact(report)).not.toThrow()

        const incomplete = animationReportV2()
        incomplete.measurementContract.metricCatalogVersion = 3
        Object.assign(incomplete.attempts[0]!.capabilities, { videoPlaybackQuality: true })
        incomplete.attempts[0]!.metrics = [
            videoWindowMetric({
                scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
                aggregation: { population: 'media-frames', method: 'ratio' },
            }),
        ]
        const secondAttempt = {
            ...incomplete.attempts[0]!,
            attemptId: 'attempt_2',
            index: 2,
            capabilities: { ...incomplete.attempts[0]!.capabilities },
            metrics: [],
            actionWindows: [...incomplete.attempts[0]!.actionWindows],
        }
        delete (secondAttempt.capabilities as Record<string, unknown>).videoPlaybackQuality
        incomplete.attempts.push(secondAttempt)
        incomplete.aggregateMetrics = [
            videoWindowMetric({
                status: 'partial',
                limitations: [
                    'video-playback-quality-window-counter-delta',
                    'video-playback-quality-total-includes-displayed-and-dropped',
                    'video-playback-quality-window-object-identity-only',
                    'video-playback-quality-not-decode-presentation-or-gpu-timing',
                    'eligible-attempts-1',
                    'total-attempts-2',
                ],
            }),
        ]
        incomplete.findings = []
        expect(() => parseAnimationReportArtifact(incomplete)).toThrow('missing capability evidence')
    })

    it('parses the input-frame and LoAF attribution metric families in catalog v2 without synthesizing unavailable values', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        Object.assign(report.attempts[0]!.capabilities, {
            inputFrameScheduling: true,
            loafFirstUIEventTimestamp: true,
            loafForcedStyleAndLayoutDuration: true,
        })
        report.attempts[0]!.metrics = ADDITIONAL_CATALOG_V2_METRICS.map(definition =>
            additionalCatalogV2Metric(definition, {
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: {
                    population: definition.capability === 'inputFrameScheduling' ? 'events' : 'frames',
                    method: definition.stat === 'count' ? 'count' : 'nearest-rank',
                },
                limitations: [],
            })
        )
        report.aggregateMetrics = ADDITIONAL_CATALOG_V2_METRICS.map(definition => additionalCatalogV2Metric(definition))
        report.findings = []

        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.metrics.map(item => item.metricId)).toEqual(
            ADDITIONAL_CATALOG_V2_METRICS.map(definition => definition.metricId)
        )
        expect(parsed.compactSummary.metrics?.map(item => item.name)).toEqual(
            ADDITIONAL_CATALOG_V2_METRICS.map(definition => definition.name)
        )
        expect(parsed.compactSummary.metrics?.every(item => !('metricId' in item))).toBe(true)
        expect(parsed.compactSummary.capabilities).toEqual(
            expect.objectContaining({
                inputFrameScheduling: true,
                loafFirstUIEventTimestamp: true,
                loafForcedStyleAndLayoutDuration: true,
            })
        )

        const unavailable = animationReportV2()
        unavailable.measurementContract.metricCatalogVersion = 2
        Object.assign(unavailable.attempts[0]!.capabilities, {
            inputFrameScheduling: false,
            loafFirstUIEventTimestamp: null,
            loafForcedStyleAndLayoutDuration: false,
        })
        unavailable.attempts[0]!.metrics = ADDITIONAL_CATALOG_V2_METRICS.map(definition =>
            additionalCatalogV2Metric(definition, {
                value: null,
                samples: null,
                status: definition.capability === 'loafFirstUIEventTimestamp' ? 'unknown' : 'unsupported',
                evidenceLevel: 'unsupported-or-unknown',
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: {
                    population: definition.capability === 'inputFrameScheduling' ? 'events' : 'frames',
                    method: definition.stat === 'count' ? 'count' : 'nearest-rank',
                },
                limitations: ['capability-unavailable'],
            })
        )
        unavailable.aggregateMetrics = ADDITIONAL_CATALOG_V2_METRICS.map(definition =>
            additionalCatalogV2Metric(definition, {
                value: null,
                samples: 0,
                status: definition.capability === 'loafFirstUIEventTimestamp' ? 'unknown' : 'unsupported',
                evidenceLevel: 'unsupported-or-unknown',
                limitations: ['capability-unavailable'],
            })
        )
        unavailable.findings = []

        const parsedUnavailable = parseAnimationReportArtifact(unavailable)
        expect(parsedUnavailable.analysis?.measurementContract.metricCatalogVersion).toBe(2)
        expect(parsedUnavailable.compactSummary.metrics).toHaveLength(ADDITIONAL_CATALOG_V2_METRICS.length)
        expect(parsedUnavailable.compactSummary.metrics?.every(metric => metric.value === null)).toBe(true)
        expect(parsedUnavailable.compactSummary.capabilities).toEqual(
            expect.objectContaining({
                inputFrameScheduling: false,
                loafFirstUIEventTimestamp: null,
                loafForcedStyleAndLayoutDuration: false,
            })
        )
    })

    it.each(ADDITIONAL_CATALOG_V2_METRICS)('rejects $metricId when a report claims metric catalog v1', definition => {
        const report = animationReportV2()
        report.attempts[0]!.metrics = [
            additionalCatalogV2Metric(definition, {
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: {
                    population: definition.capability === 'inputFrameScheduling' ? 'events' : 'frames',
                    method: definition.stat === 'count' ? 'count' : 'nearest-rank',
                },
                limitations: [],
            }),
        ]
        report.aggregateMetrics = []
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow('requires metric catalog v2')
    })

    it.each(ADDITIONAL_CATALOG_V2_METRICS)('rejects $metricId when its capability contradicts the measured status', definition => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        ;(report.attempts[0]!.capabilities as Record<string, boolean | null>)[definition.capability] = false
        report.attempts[0]!.metrics = [
            additionalCatalogV2Metric(definition, {
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: {
                    population: definition.capability === 'inputFrameScheduling' ? 'events' : 'frames',
                    method: definition.stat === 'count' ? 'count' : 'nearest-rank',
                },
                limitations: [],
            }),
        ]
        report.aggregateMetrics = []
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow(`${definition.capability} capability conflicts`)
    })

    it('rejects nullable input-frame scheduling and not-observed counts for a supported capability', () => {
        const definition = ADDITIONAL_CATALOG_V2_METRICS[0]
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        const reportCapabilities = report.attempts[0]!.capabilities as Record<string, boolean | null>
        reportCapabilities.inputFrameScheduling = null
        report.attempts[0]!.metrics = [
            additionalCatalogV2Metric(definition, {
                value: null,
                samples: 0,
                status: 'unknown',
                evidenceLevel: 'unsupported-or-unknown',
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'events', method: 'count' },
                limitations: ['input-frame-scheduling-unknown'],
            }),
        ]
        report.aggregateMetrics = []
        report.findings = []
        expect(() => parseAnimationReportArtifact(report)).toThrow('inputFrameScheduling must be a boolean')

        reportCapabilities.inputFrameScheduling = true
        report.attempts[0]!.metrics[0]!.status = 'not-observed'
        report.attempts[0]!.metrics[0]!.evidenceLevel = 'controlled-lab-measurement'
        expect(() => parseAnimationReportArtifact(report)).toThrow('inputFrameScheduling capability conflicts')

        report.attempts[0]!.metrics = [
            additionalCatalogV2Metric(ADDITIONAL_CATALOG_V2_METRICS[1], {
                value: null,
                samples: 0,
                status: 'not-observed',
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'events', method: 'nearest-rank' },
                limitations: ['no-retained-input-frame-samples'],
            }),
        ]
        expect(parseAnimationReportArtifact(report).analysis?.measurementContract.metricCatalogVersion).toBe(2)
    })

    it('accepts compact cataloged Lighthouse metrics emitted by the runner and rejects forged tuples', () => {
        const report = animationReportV2()
        expect(parseAnimationReportArtifact(report).lighthouse?.metrics[0]).toEqual(
            expect.objectContaining({ id: 'lighthouse.LCP.latest', value: 1_900 })
        )

        report.lighthouse.metrics[0]!.name = 'forgedLcp'
        expect(() => parseAnimationReportArtifact(report)).toThrow('does not match the canonical metric catalog')
    })

    it('requires a closed Lighthouse metric id and rejects non-Lighthouse catalog entries', () => {
        const missingId = animationReportV2()
        delete (missingId.lighthouse.metrics[0] as Record<string, unknown>).metricId
        expect(() => parseAnimationReportArtifact(missingId)).toThrow('metricId is required')

        const foreignMetric = animationReportV2()
        Object.assign(foreignMetric.lighthouse.metrics[0] as Record<string, unknown>, {
            family: 'frameCadence',
            name: 'frameDurationMs',
            stat: 'p95',
            unit: 'ms',
            value: 18.4,
            metricId: 'frame.duration.p95',
        })
        expect(() => parseAnimationReportArtifact(foreignMetric)).toThrow('is not a Lighthouse metric')
    })

    it('rejects expanded generic metrics in the compact Lighthouse section', () => {
        const report = animationReportV2()
        report.lighthouse.metrics = [
            loafPaintMetric({
                scope: { level: 'run' },
                aggregation: { population: 'frames', method: 'nearest-rank' },
                limitations: [],
            }),
        ]
        expect(() => parseAnimationReportArtifact(report)).toThrow('must use the compact Lighthouse metric shape')
    })

    it('rejects LoAF paint metrics that contradict attempt capabilities', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        report.attempts[0]!.metrics = [
            loafPaintMetric({
                value: 0,
                samples: 0,
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'frames', method: 'nearest-rank' },
                limitations: [],
            }),
        ]
        report.aggregateMetrics = [loafPaintMetric({ value: 0, samples: 0 })]
        report.findings = []
        report.attempts[0]!.capabilities.loafPaintTime = false
        report.attempts[0]!.capabilities.loafPresentationTime = false

        expect(() => parseAnimationReportArtifact(report)).toThrow('loafPaintTime capability conflicts')

        report.attempts[0]!.metrics[0]!.status = 'unsupported'
        ;(report.attempts[0]!.metrics[0] as Record<string, unknown>).value = null
        report.attempts[0]!.metrics[0]!.evidenceLevel = 'unsupported-or-unknown'
        Object.assign(report.aggregateMetrics[0] as Record<string, unknown>, {
            value: null,
            samples: 0,
            status: 'unsupported',
            evidenceLevel: 'unsupported-or-unknown',
            limitations: ['eligible-attempts-0', 'total-attempts-1'],
        })
        expect(parseAnimationReportArtifact(report).analysis?.measurementContract.metricCatalogVersion).toBe(2)
    })

    it('rejects unavailable compact Lighthouse metrics with a numeric value', () => {
        const report = animationReportV2()
        report.lighthouse.metrics[0]!.status = 'unsupported'
        expect(() => parseAnimationReportArtifact(report)).toThrow('unavailable status requires a null value')
    })

    it('rejects metric statuses that contradict their evidence level', () => {
        const expanded = animationReportV2()
        expanded.measurementContract.metricCatalogVersion = 2
        expanded.attempts[0]!.metrics = [
            loafPaintMetric({
                value: null,
                samples: null,
                status: 'unsupported',
                evidenceLevel: 'controlled-lab-measurement',
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'frames', method: 'nearest-rank' },
                limitations: ['capability-unavailable'],
            }),
        ]
        expanded.aggregateMetrics = []
        expanded.findings = []
        expanded.attempts[0]!.capabilities.loafPaintTime = false
        expanded.attempts[0]!.capabilities.loafPresentationTime = false
        expect(() => parseAnimationReportArtifact(expanded)).toThrow('status conflicts with evidenceLevel')

        const compact = animationReportV2()
        compact.lighthouse.metrics[0]!.status = 'measured'
        compact.lighthouse.metrics[0]!.evidenceLevel = 'unsupported-or-unknown'
        expect(() => parseAnimationReportArtifact(compact)).toThrow('status conflicts with evidenceLevel')
    })

    it('accepts the legacy catalog v1 unsupported evidence shape', () => {
        const report = animationReportV2()
        Object.assign(report.attempts[0]!.metrics[0] as Record<string, unknown>, {
            value: null,
            samples: null,
            status: 'unsupported',
            evidenceLevel: 'controlled-lab-measurement',
        })
        report.aggregateMetrics = []
        report.findings = []

        expect(parseAnimationReportArtifact(report).analysis?.measurementContract.metricCatalogVersion).toBe(1)
    })

    it('rejects duplicate aggregate scope identities and aggregate capabilities forged above measured attempts', () => {
        const duplicate = animationReportV2()
        duplicate.aggregateMetrics.push({ ...duplicate.aggregateMetrics[0]! })
        expect(() => parseAnimationReportArtifact(duplicate)).toThrow('duplicate scope identity')

        const forged = animationReportV2()
        forged.measurementContract.metricCatalogVersion = 2
        Object.assign(forged.attempts[0]!.capabilities, { inputFrameScheduling: false })
        forged.attempts[0]!.metrics = [
            additionalCatalogV2Metric(ADDITIONAL_CATALOG_V2_METRICS[0], {
                value: null,
                samples: null,
                status: 'unsupported',
                evidenceLevel: 'unsupported-or-unknown',
                scope: { level: 'attempt', attemptId: 'attempt_1' },
                aggregation: { population: 'events', method: 'count' },
                limitations: ['capability-unavailable'],
            }),
        ]
        forged.aggregateMetrics = [additionalCatalogV2Metric(ADDITIONAL_CATALOG_V2_METRICS[0])]
        forged.findings = []
        expect(() => parseAnimationReportArtifact(forged)).toThrow('invalid attempt coverage')
    })

    it('rejects low-run measured aggregates and accepts only recomputed partial evidence', () => {
        const forged = animationReportV2()
        forged.aggregateMetrics[0]!.status = 'measured'
        forged.aggregateMetrics[0]!.limitations = ['eligible-attempts-1', 'total-attempts-1']
        forged.findings = []
        expect(() => parseAnimationReportArtifact(forged)).toThrow('conflicts with measured attempts')

        const honest = animationReportV2()
        honest.findings = []
        expect(parseAnimationReportArtifact(honest).analysis?.metrics[0]).toEqual(
            expect.objectContaining({ value: 18.4, samples: 120, status: 'partial' })
        )

        honest.aggregateMetrics[0]!.limitations = ['eligible-attempts-01', 'total-attempts-1']
        expect(() => parseAnimationReportArtifact(honest)).toThrow('attempt coverage')
    })

    it.each([
        ['missing total count', ['eligible-attempts-1'], 'invalid attempt coverage'],
        ['duplicate eligible count', ['eligible-attempts-1', 'eligible-attempts-1', 'total-attempts-1'], 'duplicate entries'],
        ['wrong eligible count', ['eligible-attempts-0', 'total-attempts-1'], 'invalid attempt coverage'],
        ['wrong total count', ['eligible-attempts-1', 'total-attempts-2'], 'invalid attempt coverage'],
    ])('rejects %s in aggregate attempt coverage', (_caseName, limitations, expectedMessage) => {
        const report = animationReportV2()
        report.aggregateMetrics[0]!.limitations = limitations
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow(expectedMessage)
    })

    it('rejects aggregate coverage claims on measured-attempt metrics', () => {
        const report = animationReportV2()
        report.attempts[0]!.metrics[0]!.limitations = ['eligible-attempts-1']
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow('cannot claim aggregate attempt coverage')
    })

    it('rejects ordinary aggregates when the report has no measured attempts', () => {
        const report = animationReportV2()
        report.attempts[0]!.phase = 'warmup'
        report.findings = []

        expect(() => parseAnimationReportArtifact(report)).toThrow('is missing measured-attempt evidence')
    })

    it('rejects aggregate provenance that was not derived from measured attempts', () => {
        const expectConflict = (mutate: (report: ReturnType<typeof animationReportV2>) => void) => {
            const report = animationReportV2()
            report.findings = []
            mutate(report)
            expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')
        }

        expectConflict(report => {
            report.aggregateMetrics[0]!.evidenceLevel = 'runtime-observation'
        })
        expectConflict(report => {
            report.aggregateMetrics[0]!.evidenceRefs = []
        })
        expectConflict(report => {
            report.aggregateMetrics[0]!.budgetRefs = []
        })
        expectConflict(report => {
            report.aggregateMetrics[0]!.limitations.push('aggregate-authored-claim')
        })
        expectConflict(report => {
            report.attempts[0]!.metrics[0]!.limitations = ['bounded-frame-samples']
        })
    })

    it('accepts honest partial aggregate coverage across measured attempts', () => {
        const report = animationReportV2()
        const baseAttempt = report.attempts[0]!
        report.attempts = Array.from({ length: 3 }, (_, index) => {
            const attemptId = `attempt_${index + 1}`
            return {
                ...baseAttempt,
                attemptId,
                index,
                capabilities: { ...baseAttempt.capabilities },
                actionWindows: [actionWindow()],
                metrics:
                    index < 2
                        ? [
                              expandedMetric({
                                  value: index === 0 ? 18 : 22,
                                  samples: 120,
                                  scope: { level: 'attempt', attemptId },
                                  aggregation: { population: 'frames', method: 'nearest-rank' },
                                  limitations: [],
                              }),
                          ]
                        : [],
            }
        })
        report.aggregateMetrics = [
            expandedMetric({
                value: 20,
                samples: 240,
                status: 'partial',
                limitations: ['eligible-attempts-2', 'total-attempts-3'],
            }),
        ]
        report.findings = []

        expect(parseAnimationReportArtifact(report).analysis?.metrics[0]).toEqual(
            expect.objectContaining({ value: 20, samples: 240, status: 'partial' })
        )
    })

    it('accepts only disclosed aggregate sample overflow without manufacturing a capped count', () => {
        const report = animationReportV2()
        const baseAttempt = report.attempts[0]!
        report.attempts = [0.1, 0.2, 0.3].map((value, index) => {
            const attemptId = `attempt_${index + 1}`
            return {
                ...baseAttempt,
                attemptId,
                index,
                capabilities: { ...baseAttempt.capabilities },
                limitations: [...baseAttempt.limitations],
                actionWindows: [actionWindow()],
                metrics: [
                    expandedMetric({
                        value,
                        samples: 4_000_000,
                        scope: { level: 'attempt', attemptId },
                        aggregation: { population: 'frames', method: 'nearest-rank' },
                        limitations: [],
                    }),
                ],
            }
        })
        report.aggregateMetrics = [
            expandedMetric({
                value: 0.2,
                samples: null,
                status: 'measured',
                limitations: ['eligible-attempts-3', 'total-attempts-3', 'aggregate-sample-count-exceeds-contract-bound'],
            }),
        ]
        report.findings = []

        const parsed = parseAnimationReportArtifact(report)
        expect(parsed.analysis?.metrics[0]?.samples).toBeNull()
        expect(parsed.analysis?.metrics[0]?.limitations).toContain('aggregate-sample-count-exceeds-contract-bound')
        expect(parsed.compactSummary.metrics?.[0]?.samples).toBeNull()

        report.aggregateMetrics[0]!.samples = 10_000_000
        expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')

        Object.assign(report.aggregateMetrics[0]!, { samples: null })
        report.aggregateMetrics[0]!.limitations = ['eligible-attempts-3', 'total-attempts-3']
        expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')

        const boundarySamples = [3_333_333, 3_333_333, 3_333_334]
        report.attempts.forEach((attempt, index) => {
            attempt.metrics[0]!.samples = boundarySamples[index]!
        })
        report.aggregateMetrics[0]!.samples = 10_000_000
        expect(parseAnimationReportArtifact(report).analysis?.metrics[0]?.samples).toBe(10_000_000)

        Object.assign(report.aggregateMetrics[0]!, { samples: null })
        expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')

        report.aggregateMetrics[0]!.samples = 10_000_000
        report.aggregateMetrics[0]!.limitations.push('aggregate-sample-count-exceeds-contract-bound')
        expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')

        report.attempts = report.attempts.slice(0, 2)
        report.attempts.forEach(attempt => {
            attempt.metrics[0]!.samples = 6_000_000
        })
        Object.assign(report.aggregateMetrics[0]!, {
            value: 0.15,
            samples: null,
            status: 'partial',
            limitations: ['eligible-attempts-2', 'total-attempts-2', 'aggregate-sample-count-exceeds-contract-bound'],
        })
        expect(parseAnimationReportArtifact(report).analysis?.metrics[0]?.samples).toBeNull()

        report.aggregateMetrics[0]!.samples = 10_000_000
        expect(() => parseAnimationReportArtifact(report)).toThrow('conflicts with measured attempts')
    })

    it('requires every measured attempt to back action aggregates with the matching metric and capability', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        Object.assign(report.attempts[0]!.capabilities, { inputFrameScheduling: true })
        const attemptMetric = additionalCatalogV2Metric(ADDITIONAL_CATALOG_V2_METRICS[1], {
            scope: { level: 'action', attemptId: 'attempt_1', actionId: 'hero-hover-01' },
            aggregation: { population: 'events', method: 'nearest-rank' },
            limitations: [],
        })
        report.attempts[0]!.metrics = [attemptMetric]
        const aggregateMetric = {
            ...attemptMetric,
            scope: { level: 'action', actionId: 'hero-hover-01' },
            aggregation: { population: 'attempts', method: 'median-of-attempts' },
            status: 'partial',
            limitations: ['eligible-attempts-1', 'total-attempts-1'],
        }
        report.aggregateMetrics = [aggregateMetric]
        report.findings = []
        expect(parseAnimationReportArtifact(report).analysis?.metrics[0]?.metricId).toBe('main.input-capture-to-next-raf-callback.p95')

        report.attempts[0]!.metrics = []
        expect(() => parseAnimationReportArtifact(report)).toThrow('is missing measured-attempt evidence')

        report.attempts[0]!.metrics = [attemptMetric]
        delete (report.attempts[0]!.capabilities as Record<string, unknown>).inputFrameScheduling
        expect(() => parseAnimationReportArtifact(report)).toThrow('is missing inputFrameScheduling capability')
    })

    it('accepts capability-supported unknown metrics only when cross-document coverage is explicit', () => {
        const report = animationReportV2()
        report.measurementContract.metricCatalogVersion = 2
        Object.assign(report.attempts[0]!.capabilities, { inputFrameScheduling: true })
        const unknownMetric = additionalCatalogV2Metric(ADDITIONAL_CATALOG_V2_METRICS[1], {
            value: null,
            samples: 0,
            status: 'unknown',
            evidenceLevel: 'unsupported-or-unknown',
            scope: { level: 'attempt', attemptId: 'attempt_1' },
            aggregation: { population: 'events', method: 'nearest-rank' },
            limitations: ['cross-document-sampling-partial'],
        })
        report.attempts[0]!.metrics = [unknownMetric]
        report.aggregateMetrics = [
            {
                ...unknownMetric,
                scope: { level: 'run' },
                aggregation: { population: 'attempts', method: 'median-of-attempts' },
                limitations: ['cross-document-sampling-partial', 'eligible-attempts-0', 'total-attempts-1'],
            },
        ]
        report.findings = []
        expect(parseAnimationReportArtifact(report).analysis?.metrics[0]?.status).toBe('unknown')

        report.attempts[0]!.metrics[0]!.limitations = []
        expect(() => parseAnimationReportArtifact(report)).toThrow('inputFrameScheduling capability conflicts')
    })

    it.each(['selector', 'DOM', 'text', 'url', 'credentials'])('rejects nested v2 privacy field %s', field => {
        const report = animationReportV2()
        ;(report.scenario.actions[0] as unknown as Record<string, unknown>)[field] = 'private-value'
        expect(() => parseAnimationReportArtifact(report)).toThrow(BadRequestException)
    })

    it('rejects generic v2 passthrough, partial expansion and metric catalog drift', () => {
        const passthrough = candidateFrameTailReportV2()
        ;(passthrough.findings[0] as unknown as Record<string, unknown>).details = 'unsupported data'
        expect(() => parseAnimationReportArtifact(passthrough)).toThrow(BadRequestException)

        const partial = animationReportV2()
        ;(partial.aggregateMetrics as unknown as Array<Record<string, unknown>>)[0] = {
            ...metric(),
            metricId: 'frame.duration.p95',
        }
        expect(() => parseAnimationReportArtifact(partial)).toThrow(BadRequestException)

        const drift = animationReportV2()
        drift.aggregateMetrics[0] = expandedMetric({ unit: 'count' })
        expect(() => parseAnimationReportArtifact(drift)).toThrow(BadRequestException)
    })

    it('rejects reports that claim to retain selectors or secret-bearing browser data', () => {
        const report = animationReport()
        report.privacy.selectorsRetained = true
        expect(() => parseAnimationReportArtifact(report)).toThrow(BadRequestException)

        const rawTrace = animationReport()
        rawTrace.privacy.rawTraceUploaded = true
        expect(() => parseAnimationReportArtifact(rawTrace)).toThrow('animation-report cannot upload a raw trace')

        const rawTraceV2 = animationReportV2()
        rawTraceV2.privacy.rawTraceUploaded = true
        expect(() => parseAnimationReportArtifact(rawTraceV2)).toThrow('animation-report cannot upload a raw trace')
    })
})
