import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

import { LAB_RUN_SUMMARY_MAX_BYTES, type LabRunSummary, type LabSummaryMetric } from './lab.contracts'
import {
    ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION,
    ANIMATION_LAB_METRIC_SAMPLES_MAX,
    type AnimationLabMetricV2Projection,
    type AnimationLabSemanticsV2,
    assertAnimationLabCanonicalFindings,
    assertAnimationLabMetricCatalogTupleV2,
    parseAnimationLabMetricV2,
    parseAnimationLabSemanticsV2FromReport,
} from './lab-semantics-v2'

export const LAB_PLATFORM_TIMELINE_EVENT_LIMIT = 4_000
export const LAB_ANIMATION_REPORT_DECODED_MAX_BYTES = 2 * 1024 * 1024
export const LAB_TRACE_INDEX_DECODED_MAX_BYTES = 4 * 1024 * 1024
export const LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED = 'action-scoped-metrics-retained-only-in-animation-report'
export const LAB_COMPACT_SUMMARY_METRICS_TRUNCATED = 'summary-metrics-truncated-to-byte-budget'

const MAX_DURATION_MS = 60 * 60 * 1000
const MAX_REPORT_WINDOW_MS = 2 * 60 * 60 * 1000
const MAX_TRACE_INPUT_EVENTS = 2_000_000
const MAX_METRICS = 512
const MAX_COMPACT_SUMMARY_LIMITATIONS = 64
const ELIGIBLE_ATTEMPTS_LIMITATION_PREFIX = 'eligible-attempts-'
const TOTAL_ATTEMPTS_LIMITATION_PREFIX = 'total-attempts-'
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/
const SCENARIO_PROTOCOL_HASH = /^[a-f0-9]{64}$/
const LIGHTHOUSE_METRIC_IDS = new Set([
    'lighthouse.performance.score',
    'lighthouse.accessibility.score',
    'lighthouse.best-practices.score',
    'lighthouse.seo.score',
    'lighthouse.fcp.latest',
    'lighthouse.lcp.latest',
    'lighthouse.cls.latest',
    'lighthouse.speed-index.latest',
    'lighthouse.total-blocking-time.latest',
    'lighthouse.tti.latest',
])
const CAPABILITY_BACKED_METRIC_IDS_V2 = new Set([
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-render-start-to-paint.p95',
    'pipeline.loaf-paint-to-presentation.count',
    'pipeline.loaf-paint-to-presentation.p95',
    'main.input-capture-to-next-raf-callback.count',
    'main.input-capture-to-next-raf-callback.p95',
    'interaction.loaf-first-ui-event-to-frame-end.count',
    'interaction.loaf-first-ui-event-to-frame-end.p95',
    'pipeline.loaf-attributed-forced-style-layout.count',
    'pipeline.loaf-attributed-forced-style-layout.p95',
    'media.video-window-dropped-frame-rate',
])

type RecordValue = Record<string, unknown>

type ParsedMetric = LabSummaryMetric & { evidenceLevel: AnimationLabMetricV2Projection['evidenceLevel'] }

const TRACE_ACTION_PHASES = ['script', 'style-layout', 'paint', 'composite', 'raster-gpu', 'animation', 'gc', 'other'] as const
const TRACE_ACTION_STATUSES = ['measured', 'partial', 'not-observed'] as const
const TRACE_ACTION_LIMITATIONS = [
    'trace-action-marker-not-observed',
    'trace-action-marker-ambiguous',
    'trace-action-phase-events-not-observed',
    'trace-action-thread-kind-unknown',
    'trace-action-thread-breakdown-truncated',
    'trace-action-non-laminar-overlap',
    'trace-action-cross-thread-total-may-exceed-wall-time',
    'trace-action-classification-is-correlative',
    'trace-action-raster-gpu-is-not-gpu-completion',
] as const

export type ParsedTraceActionPhaseSummary = {
    actionId: string
    actionLabel: string
    startMs: number | null
    endMs: number | null
    wallTimeMs: number | null
    status: (typeof TRACE_ACTION_STATUSES)[number]
    eventCount: number
    classifiedThreadTimeMs: number | null
    threads: Array<{
        threadId: string
        thread: (typeof TRACE_THREADS)[number]
        classifiedSelfTimeMs: number
        phases: Record<(typeof TRACE_ACTION_PHASES)[number], number>
    }>
    limitations: Array<(typeof TRACE_ACTION_LIMITATIONS)[number]>
}

export type ParsedTimeline = {
    schemaVersion: 1 | 2 | 3
    durationMs: number
    events: Array<{
        eventId: string
        name: string
        category:
            | 'interaction'
            | 'animation'
            | 'script'
            | 'long-task'
            | 'style-layout'
            | 'paint-composite'
            | 'renderer'
            | 'resource'
            | 'other'
        lane: string
        startTimeMs: number
        durationMs: number
        severity: 'info' | 'warning' | 'error'
        description: string | null
        stack: Array<{
            functionName: string | null
            fileName: string | null
            lineNumber: number | null
            columnNumber: number | null
            authoredStatus?: 'mapped' | 'not-eligible' | 'map-not-supplied' | 'segment-not-found'
            authored?: {
                fileName: string
                lineNumber: number
                columnNumber: number
            } | null
        }>
        attributes: Record<string, string | number | boolean | null>
    }>
    totalEvents: number
    truncated: boolean
    maxEvents: number
    actionPhaseSummaries: ParsedTraceActionPhaseSummary[]
    authoredSource: {
        status: 'measured' | 'partial' | 'not-observed'
        coordinateBase: 0
        frameCount: number
        eligibleFrameCount: number
        mappedFrameCount: number
        limitations: string[]
    } | null
}

export type ParsedAnimationReport = {
    runId: string
    compactSummary: LabRunSummary
    analysis: AnimationLabSemanticsV2 | null
    /** Private server-side projection used for bounded Before/After evidence. */
    measuredAttempts: Array<{
        attemptId: string
        metrics: AnimationLabMetricV2Projection[]
        capabilities: Record<string, boolean | null>
        limitations: string[]
    }>
    context: {
        startedAt: string
        endedAt: string
        durationMs: number
        routeKey: string
        scenarioProtocolHash: string | null
        environment: string
        browser: string
        browserName: string
        browserVersion: string | null
        browserHeadless: boolean
        viewport: { width: number; height: number; dpr: number }
        reducedMotion: 'no-preference' | 'reduce'
        cacheMode: 'cold' | 'warm'
        execution: {
            warmupRuns: number
            measuredRuns: number
            durationMs: number | null
            trace: boolean
            lighthouse: boolean
            colorScheme: 'light' | 'dark' | null
            cpuThrottleRate: number
            network: {
                offline?: boolean
                latencyMs?: number
                downloadBytesPerSecond?: number
                uploadBytesPerSecond?: number
            } | null
        } | null
    }
    lighthouse: {
        version: string | null
        fetchedAt: string | null
        requestedUrl: null
        finalUrl: null
        categories: Array<{ id: string; title: string; score: number | null; description: null }>
        metrics: Array<{
            id: string
            title: string
            value: number | null
            displayValue: string | null
            unit: string | null
            score: number | null
        }>
        failedAudits: Array<{
            id: string
            title: string
            description: string | null
            score: number | null
            displayValue: string | null
            details: string | null
        }>
    } | null
}

function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${label} must be an object`)
    return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).find(key => !allowedSet.has(key))
    if (unknown) throw new BadRequestException(`${label} contains unsupported field: ${unknown}`)
}

function string(value: unknown, label: string, maximumLength: number, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && !value)) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    if (value.length > maximumLength) throw new PayloadTooLargeException(`${label} exceeds ${maximumLength} characters`)
    for (const character of value) {
        const code = character.charCodeAt(0)
        if (code < 32 || code === 127) throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function token(value: unknown, label: string, maximumLength = 160): string {
    const parsed = string(value, label, maximumLength)
    if (!SAFE_TOKEN.test(parsed)) throw new BadRequestException(`Invalid ${label}`)
    return parsed
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function nullableFinite(value: unknown, label: string, minimum: number, maximum: number): number | null {
    return value === null ? null : finite(value, label, minimum, maximum)
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = finite(value, label, minimum, maximum)
    if (!Number.isInteger(parsed)) throw new BadRequestException(`Invalid ${label}`)
    return parsed
}

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new BadRequestException(`Invalid ${label}`)
    return value
}

function enumeration<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) throw new BadRequestException(`Invalid ${label}`)
    return value as T
}

function isoDate(value: unknown, label: string): string {
    const parsed = string(value, label, 40)
    if (!Number.isFinite(Date.parse(parsed))) throw new BadRequestException(`Invalid ${label}`)
    return new Date(parsed).toISOString()
}

function optionalIsoDate(value: unknown, label: string): string | null {
    if (value === '') return null
    return isoDate(value, label)
}

function boundedArray(value: unknown, label: string, maximumLength: number): unknown[] {
    if (!Array.isArray(value)) throw new BadRequestException(`${label} must be an array`)
    if (value.length > maximumLength) throw new PayloadTooLargeException(`${label} exceeds ${maximumLength} entries`)
    return value
}

function metric(
    value: unknown,
    label: string,
    semanticsV2: boolean,
    compactMetricCatalogVersion?: 1 | 2 | 3 | 4,
    compactAllowedMetricIds?: ReadonlySet<string>
): ParsedMetric {
    const raw = record(value, label)
    if (
        semanticsV2 &&
        ['scope', 'aggregation', 'budgetRefs', 'evidenceRefs', 'limitations'].some(key => Object.prototype.hasOwnProperty.call(raw, key))
    ) {
        if (compactAllowedMetricIds) throw new BadRequestException(`${label} must use the compact Lighthouse metric shape`)
        return parseAnimationLabMetricV2(raw, label, compactMetricCatalogVersion ?? 3)
    }
    exactKeys(
        raw,
        [
            'family',
            'name',
            'stat',
            'unit',
            'value',
            'samples',
            'status',
            'evidenceLevel',
            ...(compactMetricCatalogVersion ? ['metricId'] : []),
        ],
        label
    )
    const family = token(raw.family, `${label}.family`, 80)
    const name = token(raw.name, `${label}.name`, 160)
    const stat = token(raw.stat, `${label}.stat`, 40)
    const unit = token(raw.unit, `${label}.unit`, 40)
    if (compactMetricCatalogVersion !== undefined) {
        if (raw.metricId === undefined) throw new BadRequestException(`${label}.metricId is required`)
        const metricId = token(raw.metricId, `${label}.metricId`)
        assertAnimationLabMetricCatalogTupleV2({ metricId, family, name, stat, unit }, label, compactMetricCatalogVersion)
        if (compactAllowedMetricIds && !compactAllowedMetricIds.has(metricId)) {
            throw new BadRequestException(`${label} is not a Lighthouse metric`)
        }
    }
    const valueNumber = nullableFinite(raw.value, `${label}.value`, -1e15, 1e15)
    const status = enumeration(raw.status, `${label}.status`, ['measured', 'partial', 'not-observed', 'unsupported', 'unknown'] as const)
    if ((status === 'measured' || status === 'partial') && valueNumber === null) {
        throw new BadRequestException(`${label} measured status requires a value`)
    }
    if (status !== 'measured' && status !== 'partial' && valueNumber !== null) {
        throw new BadRequestException(`${label} unavailable status requires a null value`)
    }
    const evidenceLevel = enumeration(raw.evidenceLevel, `${label}.evidenceLevel`, [
        'controlled-lab-measurement',
        'runtime-observation',
        'unsupported-or-unknown',
    ] as const)
    const unavailableEvidence = status === 'unsupported' || status === 'unknown'
    if (
        (!unavailableEvidence && evidenceLevel === 'unsupported-or-unknown') ||
        ((compactMetricCatalogVersion ?? 1) >= 2 && unavailableEvidence !== (evidenceLevel === 'unsupported-or-unknown'))
    ) {
        throw new BadRequestException(`${label} status conflicts with evidenceLevel`)
    }
    return {
        family,
        name,
        stat,
        unit,
        value: valueNumber,
        samples: raw.samples === null ? null : integer(raw.samples, `${label}.samples`, 0, 1_000_000_000),
        status,
        evidenceLevel,
    }
}

function assertV2MetricCapabilities(
    metricsValue: readonly ParsedMetric[],
    capabilitiesValue: Readonly<Record<string, boolean | null>>,
    label: string
): void {
    const assertStatuses = (metricIds: readonly string[], capability: boolean | null | undefined, capabilityLabel: string): void => {
        const present = metricsValue.filter(
            (item): item is ParsedMetric & { metricId: string } =>
                'metricId' in item && typeof item.metricId === 'string' && metricIds.includes(item.metricId)
        )
        if (present.length === 0) return
        if (capability === undefined) throw new BadRequestException(`${label} is missing ${capabilityLabel} capability`)
        for (const metric of present) {
            const crossDocumentUnknown =
                metric.status === 'unknown' &&
                'limitations' in metric &&
                Array.isArray(metric.limitations) &&
                metric.limitations.includes('cross-document-sampling-partial')
            const incompleteVideoWindowUnknown =
                metric.metricId === 'media.video-window-dropped-frame-rate' &&
                metric.status === 'unknown' &&
                'limitations' in metric &&
                Array.isArray(metric.limitations) &&
                metric.limitations.includes('video-playback-quality-window-coverage-unavailable')
            const incompleteRendererUnknown =
                metric.metricId.startsWith('renderer.') &&
                metric.status === 'unknown' &&
                'limitations' in metric &&
                Array.isArray(metric.limitations) &&
                (metric.limitations.includes('renderer-host-evidence-rejected') ||
                    metric.limitations.includes('page-probe-renderer-host-evidence-truncated'))
            if (capability === false && metric.status !== 'unsupported') {
                throw new BadRequestException(`${label} ${capabilityLabel} capability conflicts with ${metric.metricId}`)
            }
            if (capability === null && metric.status !== 'unknown') {
                throw new BadRequestException(`${label} ${capabilityLabel} capability conflicts with ${metric.metricId}`)
            }
            if (
                capability === true &&
                (metric.status === 'unsupported' ||
                    (metric.status === 'unknown' && !crossDocumentUnknown && !incompleteVideoWindowUnknown && !incompleteRendererUnknown) ||
                    (metric.stat === 'count' && metric.status === 'not-observed'))
            ) {
                throw new BadRequestException(`${label} ${capabilityLabel} capability conflicts with ${metric.metricId}`)
            }
        }
    }

    const assertLoafField = (capabilityKey: string): boolean | null | undefined => {
        const hasCapability = Object.prototype.hasOwnProperty.call(capabilitiesValue, capabilityKey)
        const capability = hasCapability ? capabilitiesValue[capabilityKey] : undefined
        if (hasCapability && capabilitiesValue.loaf === false && capability !== false) {
            throw new BadRequestException(`${label} ${capabilityKey} capability conflicts with loaf=false`)
        }
        if (capability === true && capabilitiesValue.loaf !== true) {
            throw new BadRequestException(`${label} ${capabilityKey} capability requires loaf=true`)
        }
        return capability
    }

    const hasPaintTime = Object.prototype.hasOwnProperty.call(capabilitiesValue, 'loafPaintTime')
    const hasPresentationTime = Object.prototype.hasOwnProperty.call(capabilitiesValue, 'loafPresentationTime')
    const paintTime = assertLoafField('loafPaintTime')
    const presentationTime = assertLoafField('loafPresentationTime')
    if (hasPaintTime || hasPresentationTime) {
        if (!hasPaintTime || !hasPresentationTime)
            throw new BadRequestException(`${label} has an incomplete LoAF paint capability contract`)
    }

    const presentationCapability =
        paintTime === false || presentationTime === false
            ? false
            : paintTime === null || presentationTime === null
              ? null
              : paintTime === true && presentationTime === true
                ? true
                : undefined
    assertStatuses(['pipeline.loaf-render-start-to-paint.count', 'pipeline.loaf-render-start-to-paint.p95'], paintTime, 'loafPaintTime')
    assertStatuses(
        ['pipeline.loaf-paint-to-presentation.count', 'pipeline.loaf-paint-to-presentation.p95'],
        presentationCapability,
        'loafPresentationTime'
    )

    const inputFrameScheduling = Object.prototype.hasOwnProperty.call(capabilitiesValue, 'inputFrameScheduling')
        ? capabilitiesValue.inputFrameScheduling
        : undefined
    if (inputFrameScheduling === null) {
        throw new BadRequestException(`${label}.capabilities.inputFrameScheduling must be a boolean`)
    }
    assertStatuses(
        ['main.input-capture-to-next-raf-callback.count', 'main.input-capture-to-next-raf-callback.p95'],
        inputFrameScheduling,
        'inputFrameScheduling'
    )

    const loafFirstUIEventTimestamp = assertLoafField('loafFirstUIEventTimestamp')
    assertStatuses(
        ['interaction.loaf-first-ui-event-to-frame-end.count', 'interaction.loaf-first-ui-event-to-frame-end.p95'],
        loafFirstUIEventTimestamp,
        'loafFirstUIEventTimestamp'
    )

    const loafForcedStyleAndLayoutDuration = assertLoafField('loafForcedStyleAndLayoutDuration')
    assertStatuses(
        ['pipeline.loaf-attributed-forced-style-layout.count', 'pipeline.loaf-attributed-forced-style-layout.p95'],
        loafForcedStyleAndLayoutDuration,
        'loafForcedStyleAndLayoutDuration'
    )

    assertStatuses(
        ['media.video-window-dropped-frame-rate'],
        Object.prototype.hasOwnProperty.call(capabilitiesValue, 'videoPlaybackQuality')
            ? capabilitiesValue.videoPlaybackQuality
            : undefined,
        'videoPlaybackQuality'
    )
    assertStatuses(
        ['renderer.draw-calls.p95', 'renderer.triangles.p95', 'renderer.gpu-frame.p95'],
        Object.prototype.hasOwnProperty.call(capabilitiesValue, 'rendererEvidenceBridge')
            ? capabilitiesValue.rendererEvidenceBridge
            : undefined,
        'rendererEvidenceBridge'
    )
}

function expandedMetric(value: ParsedMetric): value is AnimationLabMetricV2Projection {
    return 'metricId' in value && typeof value.metricId === 'string' && 'scope' in value && typeof value.scope === 'object'
}

function normalizeVerifiedLegacyAggregateSampleOverflow<T extends ParsedMetric>(
    metricValue: T,
    verifiedLegacyOverflowIdentities: ReadonlySet<string>
): T {
    if (
        expandedMetric(metricValue) &&
        verifiedLegacyOverflowIdentities.has(aggregateScopeIdentity(metricValue)) &&
        metricValue.status === 'measured' &&
        metricValue.samples === null &&
        metricValue.limitations.includes(ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION)
    ) {
        return { ...metricValue, status: 'partial' } as T
    }
    return metricValue
}

function aggregateScopeIdentity(metricValue: AnimationLabMetricV2Projection): string {
    const scope = metricValue.scope
    const level = scope.level === 'attempt' ? 'run' : scope.level
    return [metricValue.metricId, level, scope.actionId ?? '', scope.subjectKey ?? ''].join('|')
}

function roundedMedian(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    const value = sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
    return Math.round(value * 1_000_000) / 1_000_000
}

function aggregateCapabilityForMetric(
    metricId: string,
    capabilitiesValue: Readonly<Record<string, boolean | null>>
): boolean | null | undefined {
    if (metricId.startsWith('pipeline.loaf-render-start-to-paint.')) return capabilitiesValue.loafPaintTime
    if (metricId.startsWith('pipeline.loaf-paint-to-presentation.')) {
        const paint = capabilitiesValue.loafPaintTime
        const presentation = capabilitiesValue.loafPresentationTime
        if (paint === false || presentation === false) return false
        if (paint === null || presentation === null) return null
        return paint === true && presentation === true ? true : undefined
    }
    if (metricId.startsWith('main.input-capture-to-next-raf-callback.')) return capabilitiesValue.inputFrameScheduling
    if (metricId.startsWith('interaction.loaf-first-ui-event-to-frame-end.')) return capabilitiesValue.loafFirstUIEventTimestamp
    if (metricId.startsWith('pipeline.loaf-attributed-forced-style-layout.')) {
        return capabilitiesValue.loafForcedStyleAndLayoutDuration
    }
    if (metricId === 'media.video-window-dropped-frame-rate') return capabilitiesValue.videoPlaybackQuality
    if (metricId.startsWith('renderer.')) return capabilitiesValue.rendererEvidenceBridge
    return undefined
}

type DiagnosticPhase = 'diagnostic-trace' | 'lighthouse'

function diagnosticPhaseForMetric(metricId: string): DiagnosticPhase | null {
    if (metricId.startsWith('trace.')) return 'diagnostic-trace'
    if (LIGHTHOUSE_METRIC_IDS.has(metricId)) return 'lighthouse'
    return null
}

function diagnosticCapability(phase: DiagnosticPhase): 'cdpTrace' | 'lighthouse' {
    return phase === 'diagnostic-trace' ? 'cdpTrace' : 'lighthouse'
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameBudgetRefs(
    left: readonly AnimationLabMetricV2Projection['budgetRefs'][number][],
    right: readonly AnimationLabMetricV2Projection['budgetRefs'][number][]
): boolean {
    return (
        left.length === right.length &&
        left.every((item, index) => {
            const other = right[index]
            return (
                other !== undefined &&
                item.catalogVersion === other.catalogVersion &&
                item.budgetId === other.budgetId &&
                item.budgetVersion === other.budgetVersion &&
                item.ruleId === other.ruleId
            )
        })
    )
}

function attemptCoverageLimitations(metricValue: AnimationLabMetricV2Projection): string[] {
    return metricValue.limitations.filter(
        limitation => limitation.startsWith(ELIGIBLE_ATTEMPTS_LIMITATION_PREFIX) || limitation.startsWith(TOTAL_ATTEMPTS_LIMITATION_PREFIX)
    )
}

function aggregateAttemptCoverageLimitations(eligibleAttempts: number, totalAttempts: number): [string, string] {
    return [`${ELIGIBLE_ATTEMPTS_LIMITATION_PREFIX}${eligibleAttempts}`, `${TOTAL_ATTEMPTS_LIMITATION_PREFIX}${totalAttempts}`]
}

function assertAggregateAttemptCoverage(
    metricValue: AnimationLabMetricV2Projection,
    eligibleAttempts: number,
    totalAttempts: number
): void {
    const [expectedEligible, expectedTotal] = aggregateAttemptCoverageLimitations(eligibleAttempts, totalAttempts)
    const retained = attemptCoverageLimitations(metricValue)
    if (
        retained.length !== 2 ||
        retained.filter(item => item === expectedEligible).length !== 1 ||
        retained.filter(item => item === expectedTotal).length !== 1
    ) {
        throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} has invalid attempt coverage`)
    }
}

function assertDiagnosticAggregateMetric(
    metricValue: AnimationLabMetricV2Projection,
    phase: DiagnosticPhase,
    attemptsValue: readonly {
        attemptId: string
        phase: 'warmup' | 'measured' | DiagnosticPhase
        metrics: readonly ParsedMetric[]
        capabilities: Readonly<Record<string, boolean | null>>
    }[]
): void {
    if (metricValue.scope.level !== 'run') {
        throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} diagnostic projection must use run scope`)
    }
    const capability = diagnosticCapability(phase)
    const successfulAttempts = attemptsValue.filter(item => item.phase === phase && item.capabilities[capability] === true)
    if (successfulAttempts.length !== 1) {
        throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} requires one successful ${phase} attempt`)
    }
    const sourceAttempt = successfulAttempts[0]!
    const sourceMetrics = sourceAttempt.metrics.filter(
        (item): item is AnimationLabMetricV2Projection => expandedMetric(item) && item.metricId === metricValue.metricId
    )
    if (sourceMetrics.length !== 1) {
        throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} requires one matching ${phase} metric`)
    }
    const source = sourceMetrics[0]!
    const sourceScopeMatches = source.scope.level === 'attempt' && source.scope.attemptId === sourceAttempt.attemptId
    const expectedAggregation =
        phase === 'diagnostic-trace' ? { population: 'events', method: 'sum' } : { population: 'latest', method: 'latest' }
    const aggregationMatches =
        source.aggregation.population === metricValue.aggregation.population &&
        source.aggregation.method === metricValue.aggregation.method &&
        metricValue.aggregation.population === expectedAggregation.population &&
        metricValue.aggregation.method === expectedAggregation.method
    const projectionMatches =
        source.family === metricValue.family &&
        source.name === metricValue.name &&
        source.stat === metricValue.stat &&
        source.unit === metricValue.unit &&
        source.value === metricValue.value &&
        source.samples === metricValue.samples &&
        source.status === metricValue.status &&
        source.evidenceLevel === metricValue.evidenceLevel &&
        aggregationMatches &&
        sameBudgetRefs(source.budgetRefs, metricValue.budgetRefs) &&
        sameStringArray(source.evidenceRefs, metricValue.evidenceRefs) &&
        sameStringArray(source.limitations, metricValue.limitations)
    if (!sourceScopeMatches || !projectionMatches) {
        throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} conflicts with its ${phase} attempt`)
    }
}

function assertV2AggregateMetrics(
    aggregateMetrics: readonly ParsedMetric[],
    attemptsValue: readonly {
        attemptId: string
        phase: 'warmup' | 'measured' | 'diagnostic-trace' | 'lighthouse'
        metrics: readonly ParsedMetric[]
        capabilities: Readonly<Record<string, boolean | null>>
    }[]
): ReadonlySet<string> {
    if (aggregateMetrics.some(item => !expandedMetric(item))) {
        throw new BadRequestException('animation-report.aggregateMetrics must use expanded catalog metrics')
    }
    const aggregates = aggregateMetrics.filter(expandedMetric)
    const aggregateIdentities = new Set<string>()
    const verifiedLegacyOverflowIdentities = new Set<string>()
    for (const metricValue of aggregates) {
        if (metricValue.scope.level === 'attempt' || metricValue.scope.attemptId !== undefined) {
            throw new BadRequestException('animation-report.aggregateMetrics cannot use attempt scope')
        }
        const diagnosticPhase = diagnosticPhaseForMetric(metricValue.metricId)
        if (
            diagnosticPhase === null &&
            (metricValue.aggregation.population !== 'attempts' || metricValue.aggregation.method !== 'median-of-attempts')
        ) {
            throw new BadRequestException('animation-report.aggregateMetrics must declare median-of-attempts aggregation')
        }
        const identity = aggregateScopeIdentity(metricValue)
        if (aggregateIdentities.has(identity))
            throw new BadRequestException('animation-report.aggregateMetrics contains duplicate scope identity')
        aggregateIdentities.add(identity)
    }

    const measuredAttempts = attemptsValue.filter(item => item.phase === 'measured')
    const sources = new Map<string, AnimationLabMetricV2Projection[]>()
    for (const [attemptIndex, attemptValue] of measuredAttempts.entries()) {
        const attemptIdentities = new Set<string>()
        for (const metricValue of attemptValue.metrics) {
            if (!expandedMetric(metricValue)) {
                throw new BadRequestException(`animation-report measured attempt ${attemptIndex} must use expanded catalog metrics`)
            }
            if (attemptCoverageLimitations(metricValue).length > 0) {
                throw new BadRequestException(`animation-report measured attempt ${attemptIndex} cannot claim aggregate attempt coverage`)
            }
            const identity = aggregateScopeIdentity(metricValue)
            if (attemptIdentities.has(identity)) {
                throw new BadRequestException(`animation-report measured attempt ${attemptIndex} contains duplicate metric scope identity`)
            }
            attemptIdentities.add(identity)
            const group = sources.get(identity) ?? []
            group.push(metricValue)
            sources.set(identity, group)
        }
    }

    for (const metricValue of aggregates) {
        const diagnosticPhase = diagnosticPhaseForMetric(metricValue.metricId)
        if (diagnosticPhase !== null) {
            if (metricValue.limitations.includes(ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION)) {
                throw new BadRequestException(
                    `animation-report.aggregateMetrics ${metricValue.metricId} cannot use the repeated-attempt sample overflow limitation`
                )
            }
            assertDiagnosticAggregateMetric(metricValue, diagnosticPhase, attemptsValue)
            continue
        }
        const identity = aggregateScopeIdentity(metricValue)
        const sourceMetrics = sources.get(identity) ?? []
        const capabilityBacked = CAPABILITY_BACKED_METRIC_IDS_V2.has(metricValue.metricId)
        if (measuredAttempts.length === 0 || sourceMetrics.length === 0) {
            throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} is missing measured-attempt evidence`)
        }
        const values = sourceMetrics
            .map(item => item.value)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        assertAggregateAttemptCoverage(metricValue, values.length, measuredAttempts.length)
        const rawSamples = sourceMetrics.reduce((total, item) => total + (typeof item.samples === 'number' ? item.samples : 0), 0)
        const samplesOverflow = rawSamples > ANIMATION_LAB_METRIC_SAMPLES_MAX
        const expectedSamples = samplesOverflow ? null : rawSamples
        const disclosesSamplesOverflow = metricValue.limitations.includes(ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION)
        if (
            (sourceMetrics.length > 0 &&
                ((samplesOverflow && (metricValue.samples !== null || !disclosesSamplesOverflow)) ||
                    (!samplesOverflow && disclosesSamplesOverflow))) ||
            (sourceMetrics.length === 0 && disclosesSamplesOverflow)
        ) {
            throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} conflicts with measured attempts`)
        }
        const hasCompleteAttemptCoverage =
            values.length >= 3 && values.length === measuredAttempts.length && sourceMetrics.every(item => item.status === 'measured')
        const expectedStatus: AnimationLabMetricV2Projection['status'] =
            hasCompleteAttemptCoverage && !samplesOverflow
                ? 'measured'
                : values.length > 0
                  ? 'partial'
                  : sourceMetrics.every(item => item.status === 'unsupported')
                    ? 'unsupported'
                    : sourceMetrics.every(item => item.status === 'not-observed')
                      ? 'not-observed'
                      : 'unknown'
        const expectedValue = values.length > 0 ? roundedMedian(values) : null
        const expectedEvidenceLevel: AnimationLabMetricV2Projection['evidenceLevel'] =
            expectedStatus === 'unsupported' || expectedStatus === 'unknown'
                ? 'unsupported-or-unknown'
                : (sourceMetrics.find(item => item.evidenceLevel !== 'unsupported-or-unknown')?.evidenceLevel ??
                  'controlled-lab-measurement')
        const expectedEvidenceRefs = [...new Set(sourceMetrics.flatMap(item => item.evidenceRefs))]
        const expectedLimitations = [
            ...new Set(sourceMetrics.flatMap(item => item.limitations)),
            ...aggregateAttemptCoverageLimitations(values.length, measuredAttempts.length),
            ...(samplesOverflow ? [ANIMATION_LAB_AGGREGATE_SAMPLE_OVERFLOW_LIMITATION] : []),
        ]
        const legacyMeasuredOverflow = samplesOverflow && hasCompleteAttemptCoverage && metricValue.status === 'measured'
        if (
            (metricValue.status !== expectedStatus && !legacyMeasuredOverflow) ||
            metricValue.value !== expectedValue ||
            metricValue.samples !== expectedSamples ||
            metricValue.evidenceLevel !== expectedEvidenceLevel ||
            !sameBudgetRefs(sourceMetrics[0]!.budgetRefs, metricValue.budgetRefs) ||
            !sameStringArray(expectedEvidenceRefs, metricValue.evidenceRefs) ||
            !sameStringArray(expectedLimitations, metricValue.limitations)
        ) {
            throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} conflicts with measured attempts`)
        }
        if (legacyMeasuredOverflow) verifiedLegacyOverflowIdentities.add(identity)

        const capabilityValues = measuredAttempts.map(item => aggregateCapabilityForMetric(metricValue.metricId, item.capabilities))
        if (!capabilityBacked) continue
        if (capabilityValues.some(value => value === undefined)) {
            throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} is missing capability evidence`)
        }
        if (capabilityValues.every(value => value === false)) {
            if (metricValue.status !== 'unsupported') {
                throw new BadRequestException(
                    `animation-report.aggregateMetrics ${metricValue.metricId} conflicts with unsupported capabilities`
                )
            }
            continue
        }
        if (capabilityValues.every(value => value === null)) {
            if (metricValue.status !== 'unknown') {
                throw new BadRequestException(
                    `animation-report.aggregateMetrics ${metricValue.metricId} conflicts with unknown capabilities`
                )
            }
            continue
        }
        if (capabilityValues.every(value => value === true)) {
            const crossDocumentUnknown =
                metricValue.status === 'unknown' && metricValue.limitations.includes('cross-document-sampling-partial')
            const incompleteVideoWindowUnknown =
                metricValue.metricId === 'media.video-window-dropped-frame-rate' &&
                metricValue.status === 'unknown' &&
                metricValue.limitations.includes('video-playback-quality-window-coverage-unavailable')
            const incompleteRendererUnknown =
                metricValue.metricId.startsWith('renderer.') &&
                metricValue.status === 'unknown' &&
                (metricValue.limitations.includes('renderer-host-evidence-rejected') ||
                    metricValue.limitations.includes('page-probe-renderer-host-evidence-truncated'))
            if (
                metricValue.status === 'unsupported' ||
                (metricValue.status === 'unknown' &&
                    !crossDocumentUnknown &&
                    !incompleteVideoWindowUnknown &&
                    !incompleteRendererUnknown) ||
                (metricValue.stat === 'count' && metricValue.status === 'not-observed')
            ) {
                throw new BadRequestException(
                    `animation-report.aggregateMetrics ${metricValue.metricId} conflicts with supported capabilities`
                )
            }
            continue
        }
        const hasSupportedCapability = capabilityValues.some(value => value === true)
        const expectedMixedStatuses = hasSupportedCapability ? ['partial', 'unknown'] : ['unknown']
        if (!expectedMixedStatuses.includes(metricValue.status)) {
            throw new BadRequestException(`animation-report.aggregateMetrics ${metricValue.metricId} conflicts with mixed capabilities`)
        }
    }
    return verifiedLegacyOverflowIdentities
}

function metrics(
    value: unknown,
    label: string,
    maximumLength = MAX_METRICS,
    semanticsV2 = false,
    compactMetricCatalogVersion?: 1 | 2 | 3 | 4,
    compactAllowedMetricIds?: ReadonlySet<string>
): ParsedMetric[] {
    return boundedArray(value, label, maximumLength).map((item, index) =>
        metric(item, `${label}[${index}]`, semanticsV2, compactMetricCatalogVersion, compactAllowedMetricIds)
    )
}

function summaryMetric(item: ParsedMetric): LabSummaryMetric {
    return {
        family: item.family,
        name: item.name,
        stat: item.stat,
        unit: item.unit,
        value: item.value,
        samples: item.samples,
        status: item.status,
        evidenceLevel: item.evidenceLevel as AnimationLabMetricV2Projection['evidenceLevel'],
    }
}

function compactSummaryLimitations(original: readonly string[], required: readonly string[]): string[] {
    const markers = [...new Set(required)]
    const originals = original.filter(item => !markers.includes(item))
    return [...originals.slice(0, Math.max(0, MAX_COMPACT_SUMMARY_LIMITATIONS - markers.length)), ...markers]
}

function compactSummaryBytes(value: LabRunSummary): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function boundedCompactSummary(params: {
    metrics: readonly LabSummaryMetric[]
    capabilities: LabRunSummary['capabilities']
    lighthouse: LabRunSummary['lighthouse']
    limitations: readonly string[]
    requiredLimitations: readonly string[]
}): LabRunSummary {
    const project = (metricCount: number, requiredLimitations: readonly string[]): LabRunSummary => {
        const limitations = compactSummaryLimitations(params.limitations, requiredLimitations)
        return {
            metrics: params.metrics.slice(0, metricCount),
            ...(params.capabilities && Object.keys(params.capabilities).length ? { capabilities: params.capabilities } : {}),
            ...(params.lighthouse ? { lighthouse: params.lighthouse } : {}),
            ...(limitations.length ? { limitations } : {}),
        }
    }

    const complete = project(params.metrics.length, params.requiredLimitations)
    if (compactSummaryBytes(complete) <= LAB_RUN_SUMMARY_MAX_BYTES) return complete

    const truncatedLimitations = [...params.requiredLimitations, LAB_COMPACT_SUMMARY_METRICS_TRUNCATED]
    let lower = 0
    let upper = params.metrics.length - 1
    let best = project(0, truncatedLimitations)
    if (compactSummaryBytes(best) > LAB_RUN_SUMMARY_MAX_BYTES) {
        throw new PayloadTooLargeException('animation-report compact summary fixed fields exceed the byte budget')
    }
    while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2)
        const candidate = project(middle, truncatedLimitations)
        if (compactSummaryBytes(candidate) <= LAB_RUN_SUMMARY_MAX_BYTES) {
            best = candidate
            lower = middle + 1
        } else {
            upper = middle - 1
        }
    }
    return best
}

function capabilities(value: unknown, label: string): Record<string, boolean | null> {
    const raw = record(value, label)
    if (Object.keys(raw).length > 128) throw new PayloadTooLargeException(`${label} exceeds 128 entries`)
    const output: Record<string, boolean | null> = {}
    for (const [key, item] of Object.entries(raw)) {
        token(key, `${label} key`, 80)
        if (item !== null && typeof item !== 'boolean') throw new BadRequestException(`Invalid ${label}.${key}`)
        output[key] = item
    }
    return output
}

function limitations(value: unknown, label: string): string[] {
    return boundedArray(value, label, 64).map((item, index) => string(item, `${label}[${index}]`, 200))
}

const TRACE_AUTHORED_STATUSES = ['mapped', 'not-eligible', 'map-not-supplied', 'segment-not-found'] as const
const TRACE_AUTHORED_SOURCE_STATUSES = ['measured', 'partial', 'not-observed'] as const
const TRACE_AUTHORED_SOURCE_LIMITATIONS = [
    'authored-source-caller-attested-map-match',
    'authored-source-retained-stack-only',
    'authored-source-is-location-not-causation',
    'authored-source-content-not-retained',
    'authored-source-map-file-rejected',
    'authored-source-map-not-supplied',
    'authored-source-segment-not-found',
    'authored-source-coordinate-basis-unknown',
    'authored-source-path-redacted',
] as const
const TRACE_SENSITIVE_PATH_SEGMENT = /^(?:\d{5,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[^/@\s]+@[^/\s]+)$/iu

function decodeTracePathSegment(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function sanitizeTracePath(pathname: string): string {
    const normalized = pathname.replace(/\\/gu, '/')
    const inputSegments = normalized.split('/')
    const homeRoot = inputSegments.findIndex(segment => /^(?:users|home)$/iu.test(segment))
    const segments = inputSegments.map((segment, index) => {
        const privateHomeSegment = homeRoot >= 0 && index === homeRoot + 1
        return privateHomeSegment || TRACE_SENSITIVE_PATH_SEGMENT.test(decodeTracePathSegment(segment))
            ? ':redacted'
            : segment.slice(0, 120)
    })
    const nonEmpty = segments.filter(Boolean)
    const retained = nonEmpty.slice(-8)
    const prefix = nonEmpty.length > retained.length ? '…/' : normalized.startsWith('/') ? '/' : ''
    return `${prefix}${retained.join('/')}`.slice(0, 512)
}

function sanitizeTraceSource(value: string): string {
    const trimmed = value.trim().slice(0, 2_048)
    if (!trimmed) return ''
    if (/^(?:blob:|data:)/iu.test(trimmed)) return `${trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()}[redacted]`
    if (/^about:/iu.test(trimmed)) return trimmed.toLowerCase() === 'about:blank' ? 'about:blank' : 'about:[redacted]'
    if (/^node:/iu.test(trimmed)) return /^node:[A-Za-z0-9_./-]{1,120}$/u.test(trimmed) ? trimmed : 'node:[redacted]'
    if (/^(?:webpack|vite):/iu.test(trimmed)) {
        return sanitizeTracePath(trimmed.replace(/^[a-z]+:(?:\/\/)?/iu, '').split(/[?#]/u, 1)[0]!)
    }
    try {
        const parsed = new URL(trimmed)
        return sanitizeTracePath(parsed.pathname || '/')
    } catch {
        return sanitizeTracePath(trimmed.split('#', 1)[0]!.split('?', 1)[0]!)
    }
}

function redactedStackSource(value: unknown, label: string): string {
    const source = string(value, label, 600, true)
    if (source !== sanitizeTraceSource(source)) {
        throw new BadRequestException(`${label} is not redacted`)
    }
    return source
}

function stackFrame(value: unknown, label: string, schemaVersion: 1 | 2 | 3) {
    const raw = record(value, label)
    exactKeys(raw, ['functionName', 'source', 'line', 'column', ...(schemaVersion === 3 ? ['authoredStatus', 'authored'] : [])], label)
    const source = redactedStackSource(raw.source, `${label}.source`)
    const generated = {
        functionName: string(raw.functionName, `${label}.functionName`, 120, true) || null,
        fileName: source || null,
        lineNumber: raw.line === null ? null : integer(raw.line, `${label}.line`, 0, 100_000_000),
        columnNumber: raw.column === null ? null : integer(raw.column, `${label}.column`, 0, 100_000_000),
    }
    if (schemaVersion !== 3) return generated
    const authoredStatus = enumeration(raw.authoredStatus, `${label}.authoredStatus`, TRACE_AUTHORED_STATUSES)
    const authoredRaw = raw.authored === null ? null : record(raw.authored, `${label}.authored`)
    if ((authoredStatus === 'mapped') !== (authoredRaw !== null)) {
        throw new BadRequestException(`${label}.authored does not match authoredStatus`)
    }
    const authored = authoredRaw
        ? (() => {
              exactKeys(authoredRaw, ['source', 'line', 'column'], `${label}.authored`)
              const authoredSource = redactedStackSource(authoredRaw.source, `${label}.authored.source`)
              if (!authoredSource) throw new BadRequestException(`${label}.authored.source is required`)
              return {
                  fileName: authoredSource,
                  lineNumber: integer(authoredRaw.line, `${label}.authored.line`, 0, 100_000_000),
                  columnNumber: integer(authoredRaw.column, `${label}.authored.column`, 0, 100_000_000),
              }
          })()
        : null
    return { ...generated, authoredStatus, authored }
}

function parseTraceAuthoredSource(value: unknown, events: ParsedTimeline['events']): NonNullable<ParsedTimeline['authoredSource']> {
    const raw = record(value, 'trace-index.authoredSource')
    exactKeys(
        raw,
        ['status', 'coordinateBase', 'frameCount', 'eligibleFrameCount', 'mappedFrameCount', 'limitations'],
        'trace-index.authoredSource'
    )
    const status = enumeration(raw.status, 'trace-index.authoredSource.status', TRACE_AUTHORED_SOURCE_STATUSES)
    if (raw.coordinateBase !== 0) throw new BadRequestException('trace-index.authoredSource.coordinateBase must be zero')
    const frames = events.flatMap(event => event.stack)
    const frameCount = integer(raw.frameCount, 'trace-index.authoredSource.frameCount', 0, LAB_PLATFORM_TIMELINE_EVENT_LIMIT * 48)
    const eligibleFrameCount = integer(raw.eligibleFrameCount, 'trace-index.authoredSource.eligibleFrameCount', 0, frameCount)
    const mappedFrameCount = integer(raw.mappedFrameCount, 'trace-index.authoredSource.mappedFrameCount', 0, eligibleFrameCount)
    const actualEligible = frames.filter(frame => frame.authoredStatus !== 'not-eligible').length
    const actualMapped = frames.filter(frame => frame.authoredStatus === 'mapped' && frame.authored !== null).length
    if (frameCount !== frames.length || eligibleFrameCount !== actualEligible || mappedFrameCount !== actualMapped) {
        throw new BadRequestException('trace-index.authoredSource counts do not match retained stack frames')
    }
    const expectedStatus =
        actualEligible > 0 && actualMapped === actualEligible ? 'measured' : actualMapped > 0 ? 'partial' : 'not-observed'
    if (status !== expectedStatus) throw new BadRequestException('trace-index.authoredSource.status does not match coverage')
    const seen = new Set<string>()
    const parsedLimitations = boundedArray(
        raw.limitations,
        'trace-index.authoredSource.limitations',
        TRACE_AUTHORED_SOURCE_LIMITATIONS.length
    ).map((item, index) => {
        const limitation = enumeration(item, `trace-index.authoredSource.limitations[${index}]`, TRACE_AUTHORED_SOURCE_LIMITATIONS)
        if (seen.has(limitation)) throw new BadRequestException('trace-index.authoredSource limitations must be unique')
        seen.add(limitation)
        return limitation
    })
    for (const required of TRACE_AUTHORED_SOURCE_LIMITATIONS.slice(0, 4)) {
        if (!seen.has(required)) throw new BadRequestException(`trace-index.authoredSource is missing ${required}`)
    }
    const relationships: Array<[boolean, (typeof TRACE_AUTHORED_SOURCE_LIMITATIONS)[number]]> = [
        [frames.some(frame => frame.authoredStatus === 'map-not-supplied'), 'authored-source-map-not-supplied'],
        [frames.some(frame => frame.authoredStatus === 'segment-not-found'), 'authored-source-segment-not-found'],
        [frames.some(frame => frame.authoredStatus === 'not-eligible'), 'authored-source-coordinate-basis-unknown'],
    ]
    for (const [present, limitation] of relationships) {
        if (seen.has(limitation) !== present) {
            throw new BadRequestException(`trace-index.authoredSource limitation ${limitation} does not match frame evidence`)
        }
    }
    return {
        status,
        coordinateBase: 0,
        frameCount,
        eligibleFrameCount,
        mappedFrameCount,
        limitations: parsedLimitations,
    }
}

const TRACE_CATEGORIES = [
    'interaction',
    'script',
    'style-layout',
    'paint',
    'composite',
    'raster-gpu',
    'network',
    'animation',
    'gc',
    'other',
] as const

const TRACE_THREADS = ['main', 'worker', 'raster', 'gpu', 'network', 'unknown'] as const

function platformCategory(category: (typeof TRACE_CATEGORIES)[number], durationMs: number, name: string) {
    if (category === 'script' && durationMs >= 50 && /(?:^|::)RunTask$/u.test(name)) return 'long-task' as const
    if (category === 'paint' || category === 'composite') return 'paint-composite' as const
    if (category === 'raster-gpu') return 'renderer' as const
    if (category === 'network') return 'resource' as const
    if (category === 'gc') return 'script' as const
    return category
}

function approximatelyEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= 0.01
}

function parseTraceActionPhaseSummaries(
    value: unknown,
    traceStartMs: number,
    traceEndMs: number,
    eligibleEventCount: number
): ParsedTraceActionPhaseSummary[] {
    const seenActionIds = new Set<string>()
    const seenActionLabels = new Set<string>()
    return boundedArray(value, 'trace-index.actionPhaseSummaries', 128).map((item, index) => {
        const label = `trace-index.actionPhaseSummaries[${index}]`
        const raw = record(item, label)
        exactKeys(
            raw,
            [
                'actionId',
                'actionLabel',
                'startMs',
                'endMs',
                'wallTimeMs',
                'status',
                'eventCount',
                'classifiedThreadTimeMs',
                'threads',
                'limitations',
            ],
            label
        )
        const actionId = token(raw.actionId, `${label}.actionId`)
        const actionLabel = string(raw.actionLabel, `${label}.actionLabel`, 160)
        if (seenActionIds.has(actionId) || seenActionLabels.has(actionLabel)) {
            throw new BadRequestException(`${label} duplicates an action identity`)
        }
        seenActionIds.add(actionId)
        seenActionLabels.add(actionLabel)
        const startMs = nullableFinite(raw.startMs, `${label}.startMs`, traceStartMs, traceEndMs)
        const endMs = nullableFinite(raw.endMs, `${label}.endMs`, traceStartMs, traceEndMs)
        const wallTimeMs = nullableFinite(raw.wallTimeMs, `${label}.wallTimeMs`, 0, MAX_DURATION_MS)
        const status = enumeration(raw.status, `${label}.status`, TRACE_ACTION_STATUSES)
        if ((startMs === null) !== (endMs === null) || (startMs === null) !== (wallTimeMs === null)) {
            throw new BadRequestException(`${label} action window fields must be all null or all measured`)
        }
        if (startMs !== null && endMs !== null && wallTimeMs !== null) {
            if (endMs < startMs || !approximatelyEqual(endMs - startMs, wallTimeMs)) {
                throw new BadRequestException(`${label}.wallTimeMs does not match its action window`)
            }
        }
        const eventCount = integer(raw.eventCount, `${label}.eventCount`, 0, eligibleEventCount)
        const classifiedThreadTimeMs = nullableFinite(
            raw.classifiedThreadTimeMs,
            `${label}.classifiedThreadTimeMs`,
            0,
            MAX_DURATION_MS * 64
        )
        const seenThreadIds = new Set<string>()
        const threads = boundedArray(raw.threads, `${label}.threads`, 64).map((threadItem, threadIndex) => {
            const threadLabel = `${label}.threads[${threadIndex}]`
            const threadRaw = record(threadItem, threadLabel)
            exactKeys(threadRaw, ['threadId', 'thread', 'classifiedSelfTimeMs', 'phases'], threadLabel)
            const threadId = token(threadRaw.threadId, `${threadLabel}.threadId`, 80)
            if (!/^thread-[0-9a-z]+$/u.test(threadId) || seenThreadIds.has(threadId)) {
                throw new BadRequestException(`Invalid or duplicate ${threadLabel}.threadId`)
            }
            seenThreadIds.add(threadId)
            const thread = enumeration(threadRaw.thread, `${threadLabel}.thread`, TRACE_THREADS)
            const classifiedSelfTimeMs = finite(
                threadRaw.classifiedSelfTimeMs,
                `${threadLabel}.classifiedSelfTimeMs`,
                0,
                wallTimeMs ?? MAX_DURATION_MS
            )
            const phasesRaw = record(threadRaw.phases, `${threadLabel}.phases`)
            exactKeys(phasesRaw, TRACE_ACTION_PHASES, `${threadLabel}.phases`)
            const phases = Object.fromEntries(
                TRACE_ACTION_PHASES.map(phase => [
                    phase,
                    finite(phasesRaw[phase], `${threadLabel}.phases.${phase}`, 0, wallTimeMs ?? MAX_DURATION_MS),
                ])
            ) as Record<(typeof TRACE_ACTION_PHASES)[number], number>
            const phaseTotal = TRACE_ACTION_PHASES.reduce((total, phase) => total + phases[phase], 0)
            if (!approximatelyEqual(phaseTotal, classifiedSelfTimeMs)) {
                throw new BadRequestException(`${threadLabel}.classifiedSelfTimeMs does not match phases`)
            }
            return { threadId, thread, classifiedSelfTimeMs, phases }
        })
        const threadTotal = threads.reduce((total, thread) => total + thread.classifiedSelfTimeMs, 0)
        if (
            (classifiedThreadTimeMs === null) !== (threads.length === 0) ||
            (classifiedThreadTimeMs !== null && !approximatelyEqual(threadTotal, classifiedThreadTimeMs))
        ) {
            throw new BadRequestException(`${label}.classifiedThreadTimeMs does not match threads`)
        }
        const seenLimitations = new Set<string>()
        const parsedLimitations = boundedArray(raw.limitations, `${label}.limitations`, TRACE_ACTION_LIMITATIONS.length).map(
            (limitation, limitationIndex) => {
                const limitationLabel = `${label}.limitations[${limitationIndex}]`
                const parsed = enumeration(limitation, limitationLabel, TRACE_ACTION_LIMITATIONS)
                if (seenLimitations.has(parsed)) throw new BadRequestException(`${limitationLabel} is duplicated`)
                seenLimitations.add(parsed)
                return parsed
            }
        )
        if (eventCount === 0 && (classifiedThreadTimeMs !== null || threads.length !== 0)) {
            throw new BadRequestException(`${label} cannot classify thread phases without eligible events`)
        }
        if (eventCount > 0 && (classifiedThreadTimeMs === null || threads.length === 0)) {
            throw new BadRequestException(`${label} eligible events require classified thread phases`)
        }
        if (eventCount < threads.length) {
            throw new BadRequestException(`${label}.eventCount cannot be smaller than its concrete thread count`)
        }
        const markerMissing = seenLimitations.has('trace-action-marker-not-observed')
        const markerAmbiguous = seenLimitations.has('trace-action-marker-ambiguous')
        const phaseEventsMissing = seenLimitations.has('trace-action-phase-events-not-observed')
        const unknownThread = seenLimitations.has('trace-action-thread-kind-unknown')
        const threadBreakdownTruncated = seenLimitations.has('trace-action-thread-breakdown-truncated')
        const nonLaminarOverlap = seenLimitations.has('trace-action-non-laminar-overlap')
        const crossThread = seenLimitations.has('trace-action-cross-thread-total-may-exceed-wall-time')
        const correlative = seenLimitations.has('trace-action-classification-is-correlative')
        const rasterGpuBoundary = seenLimitations.has('trace-action-raster-gpu-is-not-gpu-completion')

        if (startMs === null) {
            const validMissingMarker = status === 'not-observed' && markerMissing && !markerAmbiguous && parsedLimitations.length === 1
            const validAmbiguousMarker = status === 'partial' && markerAmbiguous && !markerMissing && parsedLimitations.length === 1
            if (!validMissingMarker && !validAmbiguousMarker) {
                throw new BadRequestException(`${label} null action window has contradictory status or limitations`)
            }
            if (eventCount !== 0 || classifiedThreadTimeMs !== null || threads.length !== 0) {
                throw new BadRequestException(`${label} null action window cannot contain classified phase evidence`)
            }
        } else if (status === 'not-observed') {
            if (
                eventCount !== 0 ||
                classifiedThreadTimeMs !== null ||
                threads.length !== 0 ||
                !correlative ||
                !phaseEventsMissing ||
                parsedLimitations.length !== 2
            ) {
                throw new BadRequestException(`${label} unobserved phase window has contradictory evidence or limitations`)
            }
        } else {
            if (eventCount === 0 || classifiedThreadTimeMs === null || threads.length === 0 || !correlative) {
                throw new BadRequestException(`${label} measured action window requires classified thread evidence`)
            }
            if (classifiedThreadTimeMs <= 0 || !threads.some(thread => TRACE_ACTION_PHASES.some(phase => thread.phases[phase] > 0))) {
                throw new BadRequestException(`${label} measured action window requires positive classified phase time`)
            }
            if (markerMissing || markerAmbiguous || phaseEventsMissing) {
                throw new BadRequestException(`${label} classified action window cannot declare missing marker or phase evidence`)
            }
            const hasPartialEvidence = unknownThread || threadBreakdownTruncated || nonLaminarOverlap
            if ((status === 'partial') !== hasPartialEvidence) {
                throw new BadRequestException(`${label} status does not match its partial trace evidence`)
            }
            if (nonLaminarOverlap && eventCount < 2) {
                throw new BadRequestException(`${label} non-laminar overlap requires at least two eligible events`)
            }
            const containsUnknownThread = threads.some(thread => thread.thread === 'unknown')
            if (unknownThread !== containsUnknownThread) {
                throw new BadRequestException(`${label} unknown-thread limitation does not match its thread evidence`)
            }
            if (threadBreakdownTruncated && (threads.length !== 64 || eventCount <= 64)) {
                throw new BadRequestException(`${label} truncated thread breakdown does not contain the bounded retained set`)
            }
            if (crossThread !== threads.length > 1) {
                throw new BadRequestException(`${label} cross-thread limitation does not match its thread evidence`)
            }
            const containsRasterGpuTime = threads.some(thread => thread.phases['raster-gpu'] > 0)
            if (rasterGpuBoundary !== containsRasterGpuTime) {
                throw new BadRequestException(`${label} raster-gpu limitation does not match its phase evidence`)
            }
        }
        return {
            actionId,
            actionLabel,
            startMs,
            endMs,
            wallTimeMs,
            status,
            eventCount,
            classifiedThreadTimeMs,
            threads,
            limitations: parsedLimitations,
        }
    })
}

export function parseTraceIndexArtifact(value: unknown): ParsedTimeline {
    const raw = record(value, 'trace-index')
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
        throw new BadRequestException('Unsupported trace-index schemaVersion')
    }
    const schemaVersion = raw.schemaVersion
    exactKeys(
        raw,
        [
            'schemaVersion',
            'startMs',
            'endMs',
            'totalInputEvents',
            'retainedEvents',
            'droppedEvents',
            'events',
            'categoryDurationMs',
            ...(schemaVersion >= 2 ? ['actionPhaseSummaries'] : []),
            ...(schemaVersion === 3 ? ['authoredSource'] : []),
        ],
        'trace-index'
    )
    const startMs = finite(raw.startMs, 'trace-index.startMs', 0, MAX_DURATION_MS)
    const endMs = finite(raw.endMs, 'trace-index.endMs', startMs, MAX_DURATION_MS)
    const totalInputEvents = integer(raw.totalInputEvents, 'trace-index.totalInputEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const retainedEvents = integer(raw.retainedEvents, 'trace-index.retainedEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const droppedEvents = integer(raw.droppedEvents, 'trace-index.droppedEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const sourceEvents = boundedArray(raw.events, 'trace-index.events', LAB_PLATFORM_TIMELINE_EVENT_LIMIT)
    if (retainedEvents !== sourceEvents.length) throw new BadRequestException('trace-index.retainedEvents does not match events')
    if (retainedEvents + droppedEvents > totalInputEvents) {
        throw new BadRequestException('trace-index event counts are inconsistent')
    }

    const durationMs = Math.max(0, endMs - startMs)
    const events = sourceEvents.map((item, index) => {
        const label = `trace-index.events[${index}]`
        const event = record(item, label)
        exactKeys(event, ['id', 'category', 'name', 'startMs', 'durationMs', 'selfTimeMs', 'thread', 'stack', 'actionLabel'], label)
        const eventDuration = finite(event.durationMs, `${label}.durationMs`, 0, MAX_DURATION_MS)
        const eventStart = finite(event.startMs, `${label}.startMs`, 0, MAX_DURATION_MS)
        if (eventStart + eventDuration > endMs + 1) throw new BadRequestException(`${label} exceeds trace bounds`)
        const category = enumeration(event.category, `${label}.category`, TRACE_CATEGORIES)
        const thread = enumeration(event.thread, `${label}.thread`, TRACE_THREADS)
        const selfTime = nullableFinite(event.selfTimeMs, `${label}.selfTimeMs`, 0, eventDuration)
        const actionLabel = event.actionLabel === undefined ? null : string(event.actionLabel, `${label}.actionLabel`, 160, true) || null
        const name = string(event.name, `${label}.name`, 120)
        const blockingCategory = ['script', 'style-layout', 'paint', 'composite', 'raster-gpu', 'gc'].includes(category)
        const severity: 'info' | 'warning' | 'error' =
            blockingCategory && eventDuration >= 200 ? 'error' : blockingCategory && eventDuration >= 50 ? 'warning' : 'info'
        return {
            eventId: token(event.id, `${label}.id`, 160),
            name,
            category: platformCategory(category, eventDuration, name),
            lane: thread,
            startTimeMs: eventStart,
            durationMs: eventDuration,
            severity,
            description: actionLabel ? `场景动作：${actionLabel}` : null,
            stack: boundedArray(event.stack, `${label}.stack`, 48).map((frame, frameIndex) =>
                stackFrame(frame, `${label}.stack[${frameIndex}]`, schemaVersion)
            ),
            attributes: {
                thread,
                selfTimeMs: selfTime,
                actionLabel,
            },
        }
    })

    const categoryDuration = record(raw.categoryDurationMs, 'trace-index.categoryDurationMs')
    exactKeys(categoryDuration, TRACE_CATEGORIES, 'trace-index.categoryDurationMs')
    for (const category of TRACE_CATEGORIES) {
        finite(categoryDuration[category], `trace-index.categoryDurationMs.${category}`, 0, MAX_DURATION_MS * MAX_TRACE_INPUT_EVENTS)
    }

    const actionPhaseSummaries =
        schemaVersion >= 2 ? parseTraceActionPhaseSummaries(raw.actionPhaseSummaries, startMs, endMs, retainedEvents + droppedEvents) : []
    const authoredSource = schemaVersion === 3 ? parseTraceAuthoredSource(raw.authoredSource, events) : null

    return {
        schemaVersion,
        durationMs,
        events,
        totalEvents: retainedEvents + droppedEvents,
        truncated: droppedEvents > 0,
        maxEvents: LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
        actionPhaseSummaries,
        authoredSource,
    }
}

function scenario(value: unknown, semanticsV2: boolean) {
    const raw = record(value, 'animation-report.scenario')
    exactKeys(
        raw,
        [
            'name',
            'routeKey',
            'protocolHash',
            'release',
            'dist',
            'environment',
            'viewport',
            'reducedMotion',
            'cacheMode',
            'execution',
            'actionLabels',
            ...(semanticsV2 ? ['actions'] : []),
        ],
        'animation-report.scenario'
    )
    const viewportRaw = record(raw.viewport, 'animation-report.scenario.viewport')
    exactKeys(viewportRaw, ['width', 'height', 'deviceScaleFactor'], 'animation-report.scenario.viewport')
    const actionLabels = boundedArray(raw.actionLabels, 'animation-report.scenario.actionLabels', 128)
    actionLabels.forEach((item, index) => string(item, `animation-report.scenario.actionLabels[${index}]`, 160))
    let execution: ParsedAnimationReport['context']['execution'] = null
    if (raw.execution !== undefined) {
        const executionRaw = record(raw.execution, 'animation-report.scenario.execution')
        exactKeys(
            executionRaw,
            ['warmupRuns', 'measuredRuns', 'durationMs', 'trace', 'lighthouse', 'colorScheme', 'cpuThrottleRate', 'network'],
            'animation-report.scenario.execution'
        )
        let network: NonNullable<ParsedAnimationReport['context']['execution']>['network'] = null
        if (executionRaw.network !== null) {
            const networkRaw = record(executionRaw.network, 'animation-report.scenario.execution.network')
            exactKeys(
                networkRaw,
                ['offline', 'latencyMs', 'downloadBytesPerSecond', 'uploadBytesPerSecond'],
                'animation-report.scenario.execution.network'
            )
            network = {
                ...(networkRaw.offline === undefined
                    ? {}
                    : { offline: boolean(networkRaw.offline, 'animation-report.scenario.execution.network.offline') }),
                ...(networkRaw.latencyMs === undefined
                    ? {}
                    : {
                          latencyMs: finite(networkRaw.latencyMs, 'animation-report.scenario.execution.network.latencyMs', 0, 120_000),
                      }),
                ...(networkRaw.downloadBytesPerSecond === undefined
                    ? {}
                    : {
                          downloadBytesPerSecond: finite(
                              networkRaw.downloadBytesPerSecond,
                              'animation-report.scenario.execution.network.downloadBytesPerSecond',
                              1,
                              1_000_000_000
                          ),
                      }),
                ...(networkRaw.uploadBytesPerSecond === undefined
                    ? {}
                    : {
                          uploadBytesPerSecond: finite(
                              networkRaw.uploadBytesPerSecond,
                              'animation-report.scenario.execution.network.uploadBytesPerSecond',
                              1,
                              1_000_000_000
                          ),
                      }),
            }
        }
        execution = {
            warmupRuns: integer(executionRaw.warmupRuns, 'animation-report.scenario.execution.warmupRuns', 0, 10),
            measuredRuns: integer(executionRaw.measuredRuns, 'animation-report.scenario.execution.measuredRuns', 3, 20),
            durationMs:
                executionRaw.durationMs === undefined
                    ? null
                    : integer(executionRaw.durationMs, 'animation-report.scenario.execution.durationMs', 5_000, 120_000),
            trace: boolean(executionRaw.trace, 'animation-report.scenario.execution.trace'),
            lighthouse: boolean(executionRaw.lighthouse, 'animation-report.scenario.execution.lighthouse'),
            colorScheme:
                executionRaw.colorScheme === null
                    ? null
                    : enumeration(executionRaw.colorScheme, 'animation-report.scenario.execution.colorScheme', ['light', 'dark'] as const),
            cpuThrottleRate: finite(executionRaw.cpuThrottleRate, 'animation-report.scenario.execution.cpuThrottleRate', 1, 20),
            network,
        }
    }
    const reducedMotion = enumeration(raw.reducedMotion, 'animation-report.scenario.reducedMotion', ['no-preference', 'reduce'] as const)
    const cacheMode = enumeration(raw.cacheMode, 'animation-report.scenario.cacheMode', ['cold', 'warm'] as const)
    const protocolHash = raw.protocolHash === undefined ? null : string(raw.protocolHash, 'animation-report.scenario.protocolHash', 64)
    if (protocolHash !== null && !SCENARIO_PROTOCOL_HASH.test(protocolHash)) {
        throw new BadRequestException('Invalid animation-report.scenario.protocolHash')
    }
    return {
        name: string(raw.name, 'animation-report.scenario.name', 120),
        routeKey: token(raw.routeKey, 'animation-report.scenario.routeKey', 160),
        protocolHash,
        release: string(raw.release, 'animation-report.scenario.release', 120, true),
        dist: string(raw.dist, 'animation-report.scenario.dist', 120, true),
        environment: string(raw.environment, 'animation-report.scenario.environment', 120, true),
        viewport: {
            width: integer(viewportRaw.width, 'animation-report.scenario.viewport.width', 240, 7680),
            height: integer(viewportRaw.height, 'animation-report.scenario.viewport.height', 240, 4320),
            dpr: finite(viewportRaw.deviceScaleFactor, 'animation-report.scenario.viewport.deviceScaleFactor', 0.5, 8),
        },
        reducedMotion,
        cacheMode,
        execution,
    }
}

function attempt(value: unknown, index: number, semanticsV2: boolean, metricCatalogVersion: 1 | 2 | 3 | 4) {
    const label = `animation-report.attempts[${index}]`
    const raw = record(value, label)
    exactKeys(
        raw,
        [
            'attemptId',
            'phase',
            'index',
            'startedAt',
            'endedAt',
            'durationMs',
            'observationDurationMs',
            'metrics',
            'capabilities',
            'limitations',
            ...(semanticsV2 ? ['actionWindows'] : []),
        ],
        label
    )
    const attemptId = token(raw.attemptId, `${label}.attemptId`, 160)
    const phase = enumeration(raw.phase, `${label}.phase`, ['warmup', 'measured', 'diagnostic-trace', 'lighthouse'] as const)
    integer(raw.index, `${label}.index`, 0, 100)
    const startedAt = isoDate(raw.startedAt, `${label}.startedAt`)
    const endedAt = isoDate(raw.endedAt, `${label}.endedAt`)
    const durationMs = finite(raw.durationMs, `${label}.durationMs`, 0, MAX_DURATION_MS)
    const observationDurationMs =
        raw.observationDurationMs === undefined
            ? null
            : finite(raw.observationDurationMs, `${label}.observationDurationMs`, 0, MAX_DURATION_MS)
    const wallDurationMs = Date.parse(endedAt) - Date.parse(startedAt)
    if (wallDurationMs < 0 || Math.abs(wallDurationMs - durationMs) > 1_000) {
        throw new BadRequestException(`${label} timestamps do not match durationMs`)
    }
    if (observationDurationMs !== null && observationDurationMs > durationMs + 1) {
        throw new BadRequestException(`${label}.observationDurationMs cannot exceed durationMs`)
    }
    const parsedMetrics = metrics(raw.metrics, `${label}.metrics`, MAX_METRICS, semanticsV2, semanticsV2 ? metricCatalogVersion : undefined)
    const parsedCapabilities = capabilities(raw.capabilities, `${label}.capabilities`)
    if (semanticsV2) assertV2MetricCapabilities(parsedMetrics, parsedCapabilities, label)
    const parsedLimitations = limitations(raw.limitations, `${label}.limitations`)
    return {
        attemptId,
        phase,
        durationMs,
        observationDurationMs,
        metrics: parsedMetrics,
        capabilities: parsedCapabilities,
        limitations: parsedLimitations,
    }
}

function lighthouseAudit(value: unknown, label: string) {
    const raw = record(value, label)
    exactKeys(
        raw,
        [
            'id',
            'title',
            'score',
            'scoreDisplayMode',
            'numericValue',
            'numericUnit',
            'displayValue',
            'description',
            'savingsMs',
            'savingsBytes',
        ],
        label
    )
    const numericUnit = raw.numericUnit === null ? null : token(raw.numericUnit, `${label}.numericUnit`, 40)
    const displayValue = raw.displayValue === null ? null : string(raw.displayValue, `${label}.displayValue`, 240, true)
    const description = raw.description === null ? null : string(raw.description, `${label}.description`, 600, true)
    const savingsMs = nullableFinite(raw.savingsMs, `${label}.savingsMs`, 0, 1e15)
    const savingsBytes = nullableFinite(raw.savingsBytes, `${label}.savingsBytes`, 0, 1e15)
    const detailParts = [
        savingsMs === null ? '' : `Potential savings: ${Math.round(savingsMs)} ms`,
        savingsBytes === null ? '' : `Potential savings: ${Math.round(savingsBytes)} bytes`,
    ].filter(Boolean)
    return {
        id: token(raw.id, `${label}.id`, 160),
        title: string(raw.title, `${label}.title`, 180),
        score: nullableFinite(raw.score, `${label}.score`, 0, 1),
        scoreDisplayMode: token(raw.scoreDisplayMode, `${label}.scoreDisplayMode`, 40),
        numericValue: nullableFinite(raw.numericValue, `${label}.numericValue`, -1e15, 1e15),
        numericUnit,
        displayValue,
        description,
        details: detailParts.length ? detailParts.join('\n') : null,
    }
}

function lighthouse(
    value: unknown,
    semanticsV2: boolean,
    metricCatalogVersion: 1 | 2 | 3 | 4
): NonNullable<ParsedAnimationReport['lighthouse']> {
    const raw = record(value, 'animation-report.lighthouse')
    exactKeys(
        raw,
        ['schemaVersion', 'lighthouseVersion', 'fetchTime', 'requestedRouteKey', 'categories', 'metrics', 'failedAudits', 'diagnostics'],
        'animation-report.lighthouse'
    )
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported Lighthouse summary schemaVersion')
    token(raw.requestedRouteKey, 'animation-report.lighthouse.requestedRouteKey', 160)
    const categoryRecord = record(raw.categories, 'animation-report.lighthouse.categories')
    if (Object.keys(categoryRecord).length > 16) throw new PayloadTooLargeException('Lighthouse category limit exceeded')
    const categories = Object.entries(categoryRecord).map(([id, value]) => {
        const label = `animation-report.lighthouse.categories.${id}`
        token(id, 'Lighthouse category id', 80)
        const category = record(value, label)
        exactKeys(category, ['title', 'score'], label)
        return {
            id,
            title: string(category.title, `${label}.title`, 120),
            score: nullableFinite(category.score, `${label}.score`, 0, 1),
            description: null,
        }
    })
    const parsedMetrics = metrics(
        raw.metrics,
        'animation-report.lighthouse.metrics',
        64,
        semanticsV2,
        semanticsV2 ? metricCatalogVersion : undefined,
        semanticsV2 ? LIGHTHOUSE_METRIC_IDS : undefined
    )
    const failedAudits = boundedArray(raw.failedAudits, 'animation-report.lighthouse.failedAudits', 100).map((item, index) =>
        lighthouseAudit(item, `animation-report.lighthouse.failedAudits[${index}]`)
    )
    boundedArray(raw.diagnostics, 'animation-report.lighthouse.diagnostics', 100).forEach((item, index) =>
        lighthouseAudit(item, `animation-report.lighthouse.diagnostics[${index}]`)
    )
    return {
        version: string(raw.lighthouseVersion, 'animation-report.lighthouse.lighthouseVersion', 40, true) || null,
        fetchedAt: optionalIsoDate(raw.fetchTime, 'animation-report.lighthouse.fetchTime'),
        requestedUrl: null,
        finalUrl: null,
        categories,
        metrics: parsedMetrics.map(item => ({
            id: `${item.family}.${item.name}.${item.stat}`,
            title: item.name,
            value: item.value,
            displayValue: null,
            unit: item.unit,
            score: item.unit === 'score' ? item.value : null,
        })),
        failedAudits: failedAudits.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description,
            score: item.score,
            displayValue: item.displayValue,
            details: item.details,
        })),
    }
}

function privacy(value: unknown): void {
    const raw = record(value, 'animation-report.privacy')
    exactKeys(
        raw,
        [
            'selectorsRetained',
            'inputValuesRetained',
            'responseBodiesRetained',
            'cookiesRetained',
            'authorizationRetained',
            'screenshotsRetained',
            'rawTraceUploaded',
        ],
        'animation-report.privacy'
    )
    const prohibited = ['selectorsRetained', 'inputValuesRetained', 'responseBodiesRetained', 'cookiesRetained', 'authorizationRetained']
    for (const key of prohibited) {
        if (boolean(raw[key], `animation-report.privacy.${key}`)) {
            throw new BadRequestException(`animation-report cannot retain ${key}`)
        }
    }
    boolean(raw.screenshotsRetained, 'animation-report.privacy.screenshotsRetained')
    if (boolean(raw.rawTraceUploaded, 'animation-report.privacy.rawTraceUploaded')) {
        throw new BadRequestException('animation-report cannot upload a raw trace')
    }
}

export function parseAnimationReportArtifact(value: unknown): ParsedAnimationReport {
    const raw = record(value, 'animation-report')
    const semanticsV2 = raw.semanticsVersion !== undefined
    exactKeys(
        raw,
        [
            'schemaVersion',
            'runId',
            'scenario',
            'browser',
            'startedAt',
            'endedAt',
            'attempts',
            'aggregateMetrics',
            'timeline',
            'lighthouse',
            'privacy',
            ...(semanticsV2 ? ['semanticsVersion', 'measurementContract', 'actionWindows', 'technologyEvidence', 'findings'] : []),
        ],
        'animation-report'
    )
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported animation-report schemaVersion')
    const analysis = semanticsV2 ? parseAnimationLabSemanticsV2FromReport(raw) : null
    const metricCatalogVersion = analysis?.measurementContract.metricCatalogVersion ?? 1
    const reportRunId = string(raw.runId, 'animation-report.runId', 160)
    const parsedScenario = scenario(raw.scenario, semanticsV2)
    const browserRaw = record(raw.browser, 'animation-report.browser')
    exactKeys(browserRaw, ['name', 'version', 'headless'], 'animation-report.browser')
    const browserName = token(browserRaw.name, 'animation-report.browser.name', 40)
    const browserVersion = string(browserRaw.version, 'animation-report.browser.version', 120, true)
    const browserHeadless = boolean(browserRaw.headless, 'animation-report.browser.headless')
    const startedAt = isoDate(raw.startedAt, 'animation-report.startedAt')
    const endedAt = isoDate(raw.endedAt, 'animation-report.endedAt')
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
    if (durationMs > MAX_REPORT_WINDOW_MS) throw new BadRequestException('animation-report duration is too large')
    const parsedAttempts = boundedArray(raw.attempts, 'animation-report.attempts', 32).map((item, index) =>
        attempt(item, index, semanticsV2, metricCatalogVersion)
    )
    if (parsedScenario.execution) {
        const warmupCount = parsedAttempts.filter(item => item.phase === 'warmup').length
        const measuredCount = parsedAttempts.filter(item => item.phase === 'measured').length
        const traceAttempts = parsedAttempts.filter(item => item.phase === 'diagnostic-trace')
        const traceCount = traceAttempts.length
        const lighthouseAttempts = parsedAttempts.filter(item => item.phase === 'lighthouse')
        const lighthouseCount = lighthouseAttempts.length
        if (warmupCount !== parsedScenario.execution.warmupRuns || measuredCount !== parsedScenario.execution.measuredRuns) {
            throw new BadRequestException('animation-report attempts do not match the declared execution config')
        }
        if (traceCount !== (parsedScenario.execution.trace ? 1 : 0) || lighthouseCount !== (parsedScenario.execution.lighthouse ? 1 : 0)) {
            throw new BadRequestException('animation-report diagnostics do not match the declared execution config')
        }
        if (traceAttempts.some(item => typeof item.capabilities.cdpTrace !== 'boolean')) {
            throw new BadRequestException('animation-report trace attempt has no closed capability status')
        }
        if (lighthouseAttempts.some(item => typeof item.capabilities.lighthouse !== 'boolean')) {
            throw new BadRequestException('animation-report Lighthouse attempt has no closed capability status')
        }
        if (
            traceAttempts.some(
                item =>
                    item.capabilities.cdpTrace === false &&
                    (item.durationMs !== 0 || item.observationDurationMs !== null || item.metrics.length !== 0)
            )
        ) {
            throw new BadRequestException('animation-report unsupported trace attempt must be an empty zero-duration diagnostic')
        }
        if (
            lighthouseAttempts.some(
                item =>
                    item.capabilities.lighthouse === false &&
                    (item.durationMs !== 0 || item.observationDurationMs !== null || item.metrics.length !== 0)
            )
        ) {
            throw new BadRequestException('animation-report unavailable Lighthouse attempt must be an empty zero-duration diagnostic')
        }
        if (
            parsedScenario.execution.durationMs !== null &&
            parsedAttempts
                .filter(
                    item =>
                        item.phase === 'warmup' ||
                        item.phase === 'measured' ||
                        (item.phase === 'diagnostic-trace' && item.capabilities.cdpTrace === true)
                )
                .some(item => item.observationDurationMs === null || item.observationDurationMs + 1 < parsedScenario.execution!.durationMs!)
        ) {
            throw new BadRequestException('animation-report attempt is shorter than the declared observation duration')
        }
        if (
            raw.timeline !== undefined &&
            (!parsedScenario.execution.trace || !traceAttempts.some(item => item.capabilities.cdpTrace === true))
        ) {
            throw new BadRequestException('animation-report timeline does not match an executed CDP Trace')
        }
    }
    const parsedAggregateMetrics = metrics(
        raw.aggregateMetrics,
        'animation-report.aggregateMetrics',
        256,
        semanticsV2,
        semanticsV2 ? metricCatalogVersion : undefined
    )
    const verifiedLegacyOverflowIdentities = semanticsV2
        ? assertV2AggregateMetrics(parsedAggregateMetrics, parsedAttempts)
        : new Set<string>()
    if (semanticsV2) {
        assertAnimationLabCanonicalFindings(analysis!)
    }
    const aggregateMetrics = parsedAggregateMetrics.map(metricValue =>
        normalizeVerifiedLegacyAggregateSampleOverflow(metricValue, verifiedLegacyOverflowIdentities)
    )
    const normalizedAnalysis = analysis
        ? {
              ...analysis,
              metrics: analysis.metrics.map(metricValue =>
                  normalizeVerifiedLegacyAggregateSampleOverflow(metricValue, verifiedLegacyOverflowIdentities)
              ),
          }
        : null
    if (raw.timeline !== undefined) parseTraceIndexArtifact(raw.timeline)
    const parsedLighthouse = raw.lighthouse === undefined ? null : lighthouse(raw.lighthouse, semanticsV2, metricCatalogVersion)
    if (parsedScenario.execution) {
        const lighthouseSucceeded = parsedAttempts.some(item => item.phase === 'lighthouse' && item.capabilities.lighthouse === true)
        if ((parsedLighthouse !== null) !== lighthouseSucceeded) {
            throw new BadRequestException('animation-report Lighthouse result does not match an executed Lighthouse attempt')
        }
    }
    privacy(raw.privacy)

    const mergedCapabilities: Record<string, boolean | 'unknown' | null> = {}
    const mergedLimitations: string[] = []
    for (const item of parsedAttempts) {
        for (const [key, capability] of Object.entries(item.capabilities)) {
            const current = mergedCapabilities[key]
            mergedCapabilities[key] = current === undefined || current === capability ? capability : 'unknown'
            if (Object.keys(mergedCapabilities).length > 128) {
                throw new PayloadTooLargeException('animation-report contains too many distinct capabilities')
            }
        }
        for (const limitation of item.limitations) {
            if (!mergedLimitations.includes(limitation)) {
                if (mergedLimitations.length >= 64) {
                    throw new PayloadTooLargeException('animation-report contains too many distinct limitations')
                }
                mergedLimitations.push(limitation)
            }
        }
    }
    const lighthouseScores = parsedLighthouse
        ? Object.fromEntries(
              parsedLighthouse.categories.map(category => [
                  category.id === 'best-practices' ? 'bestPractices' : category.id,
                  category.score,
              ])
          )
        : undefined
    const lighthouseMetrics = parsedLighthouse
        ? Object.fromEntries(
              parsedLighthouse.metrics.map(item => {
                  if (item.id.length > 80) throw new PayloadTooLargeException('Lighthouse metric identifier is too long')
                  return [item.id, item.value]
              })
          )
        : undefined
    const scopedMetricsOmitted = semanticsV2 && aggregateMetrics.some(item => expandedMetric(item) && item.scope.level !== 'run')
    const summaryMetrics = (
        semanticsV2 ? aggregateMetrics.filter(item => expandedMetric(item) && item.scope.level === 'run') : aggregateMetrics
    ).map(item => summaryMetric(item))
    const compactSummary = boundedCompactSummary({
        metrics: summaryMetrics,
        capabilities: Object.keys(mergedCapabilities).length ? mergedCapabilities : undefined,
        lighthouse: parsedLighthouse
            ? {
                  scores: lighthouseScores,
                  metrics: lighthouseMetrics,
              }
            : undefined,
        limitations: mergedLimitations,
        requiredLimitations: scopedMetricsOmitted ? [LAB_COMPACT_SUMMARY_SCOPED_METRICS_OMITTED] : [],
    })
    const measuredAttempts = semanticsV2
        ? parsedAttempts
              .filter(item => item.phase === 'measured')
              .map(item => ({
                  attemptId: item.attemptId,
                  metrics: item.metrics as AnimationLabMetricV2Projection[],
                  capabilities: item.capabilities,
                  limitations: item.limitations,
              }))
        : []

    return {
        runId: reportRunId,
        compactSummary,
        analysis: normalizedAnalysis,
        measuredAttempts,
        context: {
            startedAt,
            endedAt,
            durationMs,
            routeKey: parsedScenario.routeKey,
            scenarioProtocolHash: parsedScenario.protocolHash,
            environment: parsedScenario.environment,
            browser: browserVersion ? `${browserName} ${browserVersion}` : browserName,
            browserName,
            browserVersion,
            browserHeadless,
            viewport: parsedScenario.viewport,
            reducedMotion: parsedScenario.reducedMotion,
            cacheMode: parsedScenario.cacheMode,
            execution: parsedScenario.execution,
        },
        lighthouse: parsedLighthouse,
    }
}
