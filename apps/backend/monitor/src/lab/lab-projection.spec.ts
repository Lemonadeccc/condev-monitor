import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

import { LAB_PLATFORM_TIMELINE_EVENT_LIMIT, parseAnimationReportArtifact, parseTraceIndexArtifact } from './lab-projection'

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

function expandedMetric(overrides: Record<string, unknown> = {}) {
    return {
        ...metric(),
        metricId: 'frame.duration.p95',
        scope: { level: 'run' },
        aggregation: { population: 'attempts', method: 'median-of-attempts' },
        budgetRefs: [budgetRuleRef()],
        evidenceRefs: ['runtime-browser'],
        limitations: ['eligible-attempts-3'],
        ...overrides,
    }
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
        findings: [
            {
                findingId: 'frame-tail-warning',
                ruleId: 'frame-tail',
                severity: 'warning',
                status: 'observed',
                scope: { level: 'run' },
                metricIds: ['frame.duration.p95'],
                evidenceRefs: ['runtime-browser'],
                budgetRefs: [budgetRuleRef()],
                actionIds: ['hero-hover-01'],
                limitations: [],
            },
        ],
    }
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
        const { lighthouse: _lighthouse, ...withoutLighthouse } = legacy
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
        const { lighthouse: _lighthouse, ...withoutLighthouse } = legacy
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
        const { lighthouse: _lighthouse, ...base } = legacy
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

    it('strictly projects canonical v2 semantics and preserves expanded summary metric metadata', () => {
        const parsed = parseAnimationReportArtifact(animationReportV2())

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
                findings: [expect.objectContaining({ findingId: 'frame-tail-warning' })],
            })
        )
        expect(parsed.compactSummary.metrics?.[0]).toEqual(
            expect.objectContaining({
                metricId: 'frame.duration.p95',
                evidenceLevel: 'controlled-lab-measurement',
                scope: { level: 'run' },
                budgetRefs: [expect.objectContaining({ ruleId: 'frame-tail' })],
                evidenceRefs: ['runtime-browser'],
                limitations: ['eligible-attempts-3'],
            })
        )
    })

    it.each(['selector', 'DOM', 'text', 'url', 'credentials'])('rejects nested v2 privacy field %s', field => {
        const report = animationReportV2()
        ;(report.scenario.actions[0] as unknown as Record<string, unknown>)[field] = 'private-value'
        expect(() => parseAnimationReportArtifact(report)).toThrow(BadRequestException)
    })

    it('rejects generic v2 passthrough, partial expansion and metric catalog drift', () => {
        const passthrough = animationReportV2()
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
    })
})
