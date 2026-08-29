import {
    ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
    compareAnimationLabCandidates,
    type LabComparisonCandidate,
    type LabComparisonMismatchField,
    unavailableAnimationLabComparison,
} from './lab-comparison'
import type { AnimationLabMetricV2Projection } from './lab-semantics-v2'

function metric(
    attemptId: string,
    value: number | null,
    overrides: Partial<AnimationLabMetricV2Projection> = {}
): AnimationLabMetricV2Projection {
    return {
        metricId: 'frame.duration.p95',
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value,
        samples: 120,
        status: value === null ? 'not-observed' : 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        scope: { level: 'attempt', attemptId },
        aggregation: { population: 'frames', method: 'nearest-rank' },
        budgetRefs: [
            {
                catalogVersion: 1,
                budgetId: 'condev.animation.default',
                budgetVersion: 1,
                ruleId: 'frame-tail',
            },
        ],
        evidenceRefs: ['runtime-browser'],
        limitations: [],
        ...overrides,
    }
}

function candidate(runId: string, values: readonly number[] = [16, 20, 24]): LabComparisonCandidate {
    return {
        runId,
        appId: 'app-123',
        status: 'completed',
        scenarioKey: 'hero-motion-v1',
        comparisonContext: {
            routeKey: 'examples.hero',
            scenarioProtocolHash: 'a'.repeat(64),
            environment: 'development',
            browser: { name: 'chromium', version: '152.0.7977.64', headless: true },
            viewport: { width: 1440, height: 900, dpr: 1 },
            reducedMotion: 'no-preference',
            cacheMode: 'warm',
            execution: {
                warmupRuns: 1,
                measuredRuns: values.length,
                durationMs: 10_000,
                trace: true,
                lighthouse: false,
                colorScheme: 'light',
                cpuThrottleRate: 1,
                network: null,
            },
            measurementContract: {
                contractVersion: 2,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit',
                confidence: 'explicit',
                budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
                metricCatalogVersion: 2,
            },
        },
        measuredAttempts: values.map((value, index) => {
            const attemptId = `${runId}-attempt-${index}`
            return {
                attemptId,
                metrics: [metric(attemptId, value, { samples: 100 + index * 20 })],
                capabilities: { loaf: true, longtask: true },
            }
        }),
    }
}

function clone(value: LabComparisonCandidate): LabComparisonCandidate {
    return structuredClone(value)
}

describe('animation Lab Before/After comparison core', () => {
    it('represents missing or expired raw evidence without falling back to summaries', () => {
        expect(
            unavailableAnimationLabComparison([
                { code: 'evidence-unavailable', side: 'before', field: 'animation-report-expired' },
                { code: 'evidence-unavailable', side: 'after', field: 'animation-report-missing' },
                { code: 'evidence-unavailable', side: 'after', field: 'animation-report-missing' },
            ])
        ).toEqual({
            schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: [
                { code: 'evidence-unavailable', side: 'before', field: 'animation-report-expired' },
                { code: 'evidence-unavailable', side: 'after', field: 'animation-report-missing' },
            ],
        })
    })

    it('derives bounded descriptive distributions from repeated measured attempts', () => {
        const result = compareAnimationLabCandidates(candidate('run-before'), candidate('run-after', [12, 15, 18]))

        expect(result).toEqual(
            expect.objectContaining({
                schemaVersion: ANIMATION_LAB_COMPARISON_SCHEMA_VERSION,
                kind: 'animation-lab-before-after',
                comparable: true,
                trust: 'caller-attested',
                beforeRunId: 'run-before',
                afterRunId: 'run-after',
                scenarioKey: 'hero-motion-v1',
                routeKey: 'examples.hero',
            })
        )
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics).toHaveLength(1)
        expect(result.metrics[0]).toEqual(
            expect.objectContaining({
                metricId: 'frame.duration.p95',
                comparisonAggregation: { population: 'measured-attempts', method: 'median' },
                evidenceStatus: 'measured',
                before: {
                    n: 3,
                    min: 16,
                    median: 20,
                    p75: 24,
                    p95: 24,
                    max: 24,
                    underlyingSamples: { knownAttempts: 3, total: 360, min: 100, max: 140 },
                },
                after: {
                    n: 3,
                    min: 12,
                    median: 15,
                    p75: 18,
                    p95: 18,
                    max: 18,
                    underlyingSamples: { knownAttempts: 3, total: 360, min: 100, max: 140 },
                },
                delta: -5,
                percentChange: -25,
                direction: 'decrease',
            })
        )
        expect(result.coverage).toEqual({
            beforeAttempts: 3,
            afterAttempts: 3,
            candidateMetricTuples: 1,
            comparedMetrics: 1,
            excludedMetrics: 0,
            retainedExcludedMetrics: 0,
            droppedExcludedMetrics: 0,
        })
        expect(result.caveats).toEqual(
            expect.arrayContaining([
                'host-environment-unverified',
                'caller-attested-scenario-protocol',
                'attempt-distribution-is-descriptive',
                'no-statistical-significance-inference',
            ])
        )
        expect(result).not.toHaveProperty('overallScore')
        expect(JSON.stringify(result)).not.toMatch(/improved|regressed|"trust":"verified"/iu)
    })

    it('compares catalog v4 renderer samples without treating page-level evidence as action attribution', () => {
        const rendererCandidate = (runId: string, values: readonly number[]): LabComparisonCandidate => {
            const value = candidate(runId, values)
            value.comparisonContext.measurementContract.metricCatalogVersion = 4
            value.comparisonContext.measurementContract.budgetRef.budgetVersion = 4
            value.measuredAttempts.forEach((attempt, index) => {
                attempt.capabilities = { rendererEvidenceBridge: true }
                attempt.metrics = [
                    metric(attempt.attemptId, values[index] ?? null, {
                        metricId: 'renderer.gpu-frame.p95',
                        family: 'renderer',
                        name: 'gpuFrameMs',
                        unit: 'ms',
                        samples: 30,
                        aggregation: { population: 'samples', method: 'nearest-rank' },
                        budgetRefs: [
                            {
                                catalogVersion: 1,
                                budgetId: 'condev.animation.default',
                                budgetVersion: 4,
                                ruleId: 'renderer-gpu-frame-tail',
                            },
                        ],
                        evidenceRefs: ['lab-renderer-adapter'],
                        limitations: [
                            'renderer-host-gpu-query-p95',
                            'renderer-multiple-producers-not-distinguished',
                            'renderer-gpu-action-window-not-proven',
                        ],
                    }),
                ]
            })
            return value
        }

        const result = compareAnimationLabCandidates(
            rendererCandidate('renderer-before', [18, 20, 22]),
            rendererCandidate('renderer-after', [12, 14, 16])
        )

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics).toEqual([
            expect.objectContaining({
                metricId: 'renderer.gpu-frame.p95',
                before: expect.objectContaining({ median: 20 }),
                after: expect.objectContaining({ median: 14 }),
                delta: -6,
            }),
        ])
    })

    it('compares catalog v5 caller-attested media stages descriptively without decoder or GPU claims', () => {
        const mediaCandidate = (runId: string, values: readonly number[]): LabComparisonCandidate => {
            const value = candidate(runId, values)
            value.comparisonContext.measurementContract.metricCatalogVersion = 5
            value.comparisonContext.measurementContract.budgetRef.budgetVersion = 5
            value.measuredAttempts.forEach((attempt, index) => {
                attempt.capabilities = { mediaStageEvidenceBridge: true }
                attempt.metrics = [
                    metric(attempt.attemptId, values[index] ?? null, {
                        metricId: 'media.declared-begin-to-first-visible.p95',
                        family: 'resourcesMedia',
                        name: 'declaredMediaBeginToFirstVisibleMs',
                        unit: 'ms',
                        samples: 1,
                        evidenceLevel: 'caller-attested',
                        aggregation: { population: 'samples', method: 'nearest-rank' },
                        budgetRefs: [],
                        evidenceRefs: ['lab-media-stage-attestation'],
                        limitations: [
                            'media-stage-caller-attested',
                            'media-stage-not-browser-decoder-or-gpu-proof',
                            'media-stage-complete-attempt-window-only',
                            'media-stage-kind-aggregate',
                        ],
                    }),
                ]
            })
            return value
        }

        const result = compareAnimationLabCandidates(
            mediaCandidate('media-before', [30, 32, 34]),
            mediaCandidate('media-after', [20, 22, 24])
        )

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics).toEqual([
            expect.objectContaining({
                metricId: 'media.declared-begin-to-first-visible.p95',
                before: expect.objectContaining({ median: 32 }),
                after: expect.objectContaining({ median: 22 }),
                delta: -10,
            }),
        ])
        expect(JSON.stringify(result)).not.toMatch(/"verdict"\s*:|"improved"\s*:|"regressed"\s*:|decoder completion|gpu completion/iu)
    })

    it('does not emit a formal delta when any attempt is partial, unavailable, or missing', () => {
        const cases: Array<{
            mutate: (value: LabComparisonCandidate) => void
            reason: string
        }> = [
            {
                mutate: value => {
                    value.measuredAttempts[1]!.metrics[0]!.status = 'partial'
                },
                reason: 'before-partial-status',
            },
            {
                mutate: value => {
                    Object.assign(value.measuredAttempts[1]!.metrics[0]!, {
                        value: null,
                        status: 'unknown',
                        evidenceLevel: 'unsupported-or-unknown',
                    })
                },
                reason: 'before-unavailable-status',
            },
            {
                mutate: value => {
                    value.measuredAttempts[1]!.metrics = []
                },
                reason: 'before-missing-attempt',
            },
        ]

        for (const item of cases) {
            const before = candidate('run-before')
            item.mutate(before)
            const result = compareAnimationLabCandidates(before, candidate('run-after'))

            expect(result.comparable).toBe(true)
            if (!result.comparable) throw new Error('expected a comparable result')
            expect(result.metrics).toEqual([])
            expect(result.coverage.comparedMetrics).toBe(0)
            expect(result.excluded).toHaveLength(1)
            expect(result.excluded[0]?.reasons).toContain(item.reason)
        }
    })

    it('excludes a tuple whose metric evidence contract changes between attempts or sides', () => {
        const after = candidate('run-after')
        after.measuredAttempts[2]!.metrics[0]!.evidenceRefs = ['cdp-trace']

        const result = compareAnimationLabCandidates(candidate('run-before'), after)

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics).toEqual([])
        expect(result.excluded[0]?.reasons).toContain('metric-evidence-mismatch')
    })

    it('uses a null percent change for a zero median baseline and keeps numeric direction only', () => {
        const result = compareAnimationLabCandidates(candidate('run-before', [0, 0, 1]), candidate('run-after', [1, 2, 3]))

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics[0]).toEqual(expect.objectContaining({ delta: 2, percentChange: null, direction: 'increase' }))
        expect(result.caveats).toContain('zero-baseline-percent-change-unavailable')
    })

    it('uses an even-sample median and keeps extreme finite values bounded', () => {
        const even = compareAnimationLabCandidates(candidate('run-before', [1, 2, 3, 100]), candidate('run-after', [2, 3, 4, 101]))
        expect(even.comparable).toBe(true)
        if (!even.comparable) throw new Error('expected a comparable result')
        expect(even.metrics[0]?.before).toEqual(expect.objectContaining({ n: 4, median: 2.5, p75: 3, p95: 100 }))
        expect(even.metrics[0]).toEqual(expect.objectContaining({ delta: 1, percentChange: 40 }))

        const extreme = compareAnimationLabCandidates(
            candidate('extreme-before', [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE]),
            candidate('extreme-after', [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE])
        )
        expect(extreme.comparable).toBe(true)
        if (!extreme.comparable) throw new Error('expected a comparable result')
        expect(Number.isFinite(extreme.metrics[0]!.before.median)).toBe(true)
        expect(Number.isFinite(extreme.metrics[0]!.after.median)).toBe(true)
        expect(extreme.metrics[0]?.percentChange).toBeNull()
        expect(extreme.caveats).toContain('percent-change-overflow-unavailable')

        const evenExtreme = compareAnimationLabCandidates(
            candidate('even-extreme-before', [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]),
            candidate('even-extreme-after', [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE])
        )
        expect(evenExtreme.comparable).toBe(true)
        if (!evenExtreme.comparable) throw new Error('expected a comparable result')
        expect(evenExtreme.metrics[0]?.before.median).toBe(Number.MAX_VALUE)
        expect(Number.isFinite(evenExtreme.metrics[0]!.before.median)).toBe(true)
    })

    it.each<{
        field: LabComparisonMismatchField
        mutate: (value: LabComparisonCandidate) => void
    }>([
        { field: 'app-id', mutate: value => void (value.appId = 'app-456') },
        { field: 'scenario-key', mutate: value => void (value.scenarioKey = 'other-scenario') },
        { field: 'route-key', mutate: value => void (value.comparisonContext.routeKey = 'examples.other') },
        { field: 'scenario-protocol', mutate: value => void (value.comparisonContext.scenarioProtocolHash = 'b'.repeat(64)) },
        { field: 'environment', mutate: value => void (value.comparisonContext.environment = 'production') },
        { field: 'browser-name', mutate: value => void (value.comparisonContext.browser.name = 'firefox') },
        { field: 'browser-version', mutate: value => void (value.comparisonContext.browser.version = '153.0') },
        { field: 'browser-headless', mutate: value => void (value.comparisonContext.browser.headless = false) },
        { field: 'viewport-width', mutate: value => void (value.comparisonContext.viewport.width = 1280) },
        { field: 'viewport-height', mutate: value => void (value.comparisonContext.viewport.height = 720) },
        { field: 'device-scale-factor', mutate: value => void (value.comparisonContext.viewport.dpr = 2) },
        { field: 'reduced-motion', mutate: value => void (value.comparisonContext.reducedMotion = 'reduce') },
        { field: 'cache-mode', mutate: value => void (value.comparisonContext.cacheMode = 'cold') },
        { field: 'warmup-runs', mutate: value => void (value.comparisonContext.execution.warmupRuns = 2) },
        { field: 'observation-duration', mutate: value => void (value.comparisonContext.execution.durationMs = 20_000) },
        { field: 'trace-mode', mutate: value => void (value.comparisonContext.execution.trace = false) },
        { field: 'lighthouse-mode', mutate: value => void (value.comparisonContext.execution.lighthouse = true) },
        { field: 'color-scheme', mutate: value => void (value.comparisonContext.execution.colorScheme = 'dark') },
        { field: 'cpu-throttle-rate', mutate: value => void (value.comparisonContext.execution.cpuThrottleRate = 4) },
        {
            field: 'network-profile',
            mutate: value => void (value.comparisonContext.execution.network = { latencyMs: 80, offline: false }),
        },
        {
            field: 'expected-refresh-rate',
            mutate: value => {
                value.comparisonContext.measurementContract.expectedHz = 120
                value.comparisonContext.measurementContract.targetFrameMs = 8.333333
            },
        },
        {
            field: 'target-frame-duration',
            mutate: value => void (value.comparisonContext.measurementContract.targetFrameMs = 16.7),
        },
        {
            field: 'measurement-source',
            mutate: value => void (value.comparisonContext.measurementContract.source = 'observed'),
        },
        {
            field: 'measurement-confidence',
            mutate: value => {
                value.comparisonContext.measurementContract.source = 'observed'
                value.comparisonContext.measurementContract.confidence = 'high'
            },
        },
        {
            field: 'metric-catalog-version',
            mutate: value => void (value.comparisonContext.measurementContract.metricCatalogVersion = 1),
        },
        {
            field: 'budget-reference',
            mutate: value => void (value.comparisonContext.measurementContract.budgetRef.budgetVersion = 2),
        },
        {
            field: 'capabilities',
            mutate: value => {
                value.measuredAttempts.forEach(attempt => {
                    attempt.capabilities = { ...attempt.capabilities, loaf: false }
                })
            },
        },
    ])('rejects a $field condition mismatch with a closed reason', ({ field, mutate }) => {
        const after = candidate('run-after')
        mutate(after)

        const result = compareAnimationLabCandidates(candidate('run-before'), after)

        expect(result.comparable).toBe(false)
        if (result.comparable) throw new Error('expected an incomparable result')
        expect(result.reasons).toContainEqual({ code: 'condition-mismatch', side: 'both', field })
        expect(result.reasons.every(reason => reason.code === 'condition-mismatch')).toBe(true)
    })

    it('requires at least three attempts, exact declared attempt count, and consistent capabilities within a candidate', () => {
        const tooFew = candidate('too-few', [10, 11])
        const wrongCount = candidate('wrong-count')
        wrongCount.comparisonContext.execution.measuredRuns = 5
        const mixedCapabilities = candidate('mixed-capabilities')
        mixedCapabilities.measuredAttempts[1]!.capabilities = { loaf: false, longtask: true }

        for (const [value, field] of [
            [tooFew, 'measured-attempts'],
            [wrongCount, 'measured-attempts'],
            [mixedCapabilities, 'capabilities'],
        ] as const) {
            const result = compareAnimationLabCandidates(value, candidate('run-after'))
            expect(result.comparable).toBe(false)
            if (result.comparable) throw new Error('expected an incomparable result')
            expect(result.reasons).toContainEqual({ code: 'invalid-candidate', side: 'before', field })
        }
    })

    it('rejects non-terminal, missing protocol, non-finite, forged-catalog, duplicate-scope, and oversized inputs', () => {
        const running = candidate('running')
        running.status = 'running'

        const missingProtocol = candidate('missing-protocol')
        missingProtocol.comparisonContext.scenarioProtocolHash = ''

        const missingBrowserVersion = candidate('missing-browser-version')
        missingBrowserVersion.comparisonContext.browser.version = ''

        const nonFinite = candidate('non-finite')
        nonFinite.measuredAttempts[0]!.metrics[0]!.value = Number.NaN

        const forgedCatalog = candidate('forged-catalog')
        forgedCatalog.measuredAttempts[0]!.metrics[0]!.unit = 'count'

        const duplicateScope = candidate('duplicate-scope')
        const duplicateAttempt = duplicateScope.measuredAttempts[0]!
        duplicateAttempt.metrics = [
            ...duplicateAttempt.metrics,
            metric(duplicateAttempt.attemptId, 22, { aggregation: { population: 'events', method: 'nearest-rank' } }),
        ]

        const oversized = candidate('oversized')
        const oversizedAttempt = oversized.measuredAttempts[0]!
        oversizedAttempt.metrics = Array.from({ length: 257 }, (_, index) =>
            metric(oversizedAttempt.attemptId, index, {
                scope: { level: 'subject', attemptId: oversizedAttempt.attemptId, subjectKey: `subject-${index}` },
            })
        )

        const cases = [
            { value: running, field: 'run-status' },
            { value: missingProtocol, field: 'candidate' },
            { value: missingBrowserVersion, field: 'candidate' },
            { value: nonFinite, field: 'metrics' },
            { value: forgedCatalog, field: 'metrics' },
            { value: duplicateScope, field: 'metrics' },
            { value: oversized, field: 'metrics' },
        ] as const
        for (const item of cases) {
            const result = compareAnimationLabCandidates(item.value, candidate('run-after'))
            expect(result.comparable).toBe(false)
            if (result.comparable) throw new Error('expected an incomparable result')
            expect(result.reasons).toContainEqual({ code: 'invalid-candidate', side: 'before', field: item.field })
        }
    })

    it('bounds excluded tuple detail while retaining exact exclusion coverage', () => {
        const before = candidate('run-before')
        const after = candidate('run-after')
        for (const attempt of before.measuredAttempts) {
            attempt.metrics = Array.from({ length: 256 }, (_, index) =>
                metric(attempt.attemptId, index, {
                    scope: { level: 'subject', attemptId: attempt.attemptId, subjectKey: `before-${index}` },
                })
            )
        }
        for (const attempt of after.measuredAttempts) {
            attempt.metrics = Array.from({ length: 256 }, (_, index) =>
                metric(attempt.attemptId, index, {
                    scope: { level: 'subject', attemptId: attempt.attemptId, subjectKey: `after-${index}` },
                })
            )
        }

        const result = compareAnimationLabCandidates(before, after)

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.metrics).toHaveLength(0)
        expect(result.excluded).toHaveLength(256)
        expect(result.coverage).toEqual(
            expect.objectContaining({
                candidateMetricTuples: 512,
                comparedMetrics: 0,
                excludedMetrics: 512,
                retainedExcludedMetrics: 256,
                droppedExcludedMetrics: 256,
            })
        )
    })

    it('normalizes capability and network key order without mutating either candidate', () => {
        const before = candidate('run-before')
        const after = candidate('run-after')
        before.comparisonContext.execution.network = { offline: false, latencyMs: 80 }
        after.comparisonContext.execution.network = { latencyMs: 80, offline: false }
        before.measuredAttempts.forEach(attempt => {
            attempt.capabilities = { longtask: true, loaf: true }
        })
        after.measuredAttempts.forEach(attempt => {
            attempt.capabilities = { loaf: true, longtask: true }
        })
        const beforeSnapshot = clone(before)
        const afterSnapshot = clone(after)

        const result = compareAnimationLabCandidates(before, after)

        expect(result.comparable).toBe(true)
        expect(before).toEqual(beforeSnapshot)
        expect(after).toEqual(afterSnapshot)
    })

    it('copies returned evidence so later candidate mutation cannot rewrite it', () => {
        const before = candidate('run-before')
        const result = compareAnimationLabCandidates(before, candidate('run-after'))
        before.comparisonContext.viewport.width = 320
        before.measuredAttempts[0]!.metrics[0]!.value = 999

        expect(result.comparable).toBe(true)
        if (!result.comparable) throw new Error('expected a comparable result')
        expect(result.conditions.viewport.width).toBe(1440)
        expect(result.metrics[0]?.before.median).toBe(20)
    })
})
