import type {
    AnimationRumV3Capture,
    AnimationRumV3CapturesApiResponse,
    AnimationRumV3Count,
    AnimationRumV3MetricStatus,
    AnimationRumV3MetricView,
    AnimationRumV3SummaryApiResponse,
    AnimationRumV3SummaryGroup,
} from '@/types/animation-v3'

const STATUS_LABELS: Record<AnimationRumV3MetricStatus, string> = {
    measured: '已测量',
    partial: '部分证据',
    'not-observed': '未观测到',
    'not-instrumented': '未接入',
    unsupported: '不支持',
    unknown: '未知',
}

const METRICS = {
    'vital.soft-navigation.cls.latest': { vitalName: 'CLS', unit: 'ratio' },
    'vital.soft-navigation.inp.latest': { vitalName: 'INP', unit: 'ms' },
    'vital.soft-navigation.lcp.latest': { vitalName: 'LCP', unit: 'ms' },
} as const
const STATUSES = new Set<AnimationRumV3MetricStatus>(Object.keys(STATUS_LABELS) as AnimationRumV3MetricStatus[])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u
const ROUTE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/u
const DEPLOYMENT_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u
const FRAMEWORKS = new Set(['vanilla', 'react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'mixed', 'other', 'unknown'])
const RENDERERS = new Set(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const BACKENDS = new Set(['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'])
const VISIBILITY = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORTS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const QUALITY_REASONS = new Set(['provider-rejected-samples', 'provider-truncated', 'source-field-incomplete', 'window-capped'])

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

function count(value: unknown): AnimationRumV3Count | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
    return typeof value === 'string' && /^\d+$/u.test(value) ? value : null
}

function countAtLeast(value: AnimationRumV3Count, minimum: number): boolean {
    return typeof value === 'number' ? value >= minimum : BigInt(value) >= BigInt(minimum)
}

function countBigInt(value: AnimationRumV3Count): bigint {
    return BigInt(value)
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function timestamp(value: unknown): string | null {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null
}

function closed(value: unknown, allowed: Set<string>): string | null {
    return typeof value === 'string' && allowed.has(value) ? value : null
}

function parseMetric(value: unknown): AnimationRumV3MetricView | null {
    const row = object(value)
    if (!row || typeof row.metricId !== 'string' || !(row.metricId in METRICS)) return null
    const definition = METRICS[row.metricId as keyof typeof METRICS]
    if (
        row.vitalName !== definition.vitalName ||
        row.unit !== definition.unit ||
        typeof row.status !== 'string' ||
        !STATUSES.has(row.status as AnimationRumV3MetricStatus)
    ) {
        return null
    }
    const status = row.status as AnimationRumV3MetricStatus
    const available = status === 'measured' || status === 'partial'
    const metricValue = finite(row.value)
    const samples = row.samples === 1 ? 1 : row.samples === null ? null : undefined
    if (available ? metricValue === null || samples !== 1 : row.value !== null || samples !== null) return null
    return {
        metricId: row.metricId,
        vitalName: definition.vitalName,
        unit: definition.unit,
        value: metricValue,
        samples: available ? 1 : null,
        status,
    }
}

function parseRuntime(value: unknown): { framework: string; renderer: string; backend: string } | null {
    const runtime = object(value)
    if (!runtime) return null
    const framework = closed(runtime.framework, FRAMEWORKS)
    const renderer = closed(runtime.renderer, RENDERERS)
    const backend = closed(runtime.backend, BACKENDS)
    return framework && renderer && backend ? { framework, renderer, backend } : null
}

function parseSummaryGroup(value: unknown, threshold: number): AnimationRumV3SummaryGroup | null {
    const row = object(value)
    const dimensions = object(row?.dimensions)
    const metric = object(row?.metric)
    const disclosure = object(row?.disclosure)
    const captureValue = object(row?.captureValue)
    const runtime = parseRuntime(dimensions?.runtime)
    if (!row || !dimensions || !metric || !disclosure || !captureValue || !runtime) return null
    const routeKey =
        dimensions.routeKey === null
            ? null
            : typeof dimensions.routeKey === 'string' && ROUTE_PATTERN.test(dimensions.routeKey)
              ? dimensions.routeKey
              : undefined
    const release = typeof dimensions.release === 'string' && DEPLOYMENT_PATTERN.test(dimensions.release) ? dimensions.release : null
    const environment =
        typeof dimensions.environment === 'string' && DEPLOYMENT_PATTERN.test(dimensions.environment) ? dimensions.environment : null
    if (
        routeKey === undefined ||
        release === null ||
        environment === null ||
        typeof metric.metricId !== 'string' ||
        !(metric.metricId in METRICS)
    ) {
        return null
    }
    const definition = METRICS[metric.metricId as keyof typeof METRICS]
    if (metric.vitalName !== definition.vitalName || metric.unit !== definition.unit) return null
    const counts = {
        captureCount: count(row.captureCount),
        measuredCount: count(row.measuredCount),
        partialCount: count(row.partialCount),
        notObservedCount: count(row.notObservedCount),
        notInstrumentedCount: count(row.notInstrumentedCount),
        unsupportedCount: count(row.unsupportedCount),
        unknownCount: count(row.unknownCount),
        insufficientEvidenceCount: count(row.insufficientEvidenceCount),
        reportedSamples: count(row.reportedSamples),
    }
    if (Object.values(counts).some(item => item === null) || disclosure.minimumSampleThreshold !== threshold) return null
    if (
        countBigInt(counts.measuredCount!) +
            countBigInt(counts.partialCount!) +
            countBigInt(counts.notObservedCount!) +
            countBigInt(counts.notInstrumentedCount!) +
            countBigInt(counts.unsupportedCount!) +
            countBigInt(counts.unknownCount!) !==
        countBigInt(counts.captureCount!)
    ) {
        return null
    }
    if (
        countBigInt(counts.reportedSamples!) !== countBigInt(counts.measuredCount!) + countBigInt(counts.partialCount!) ||
        countBigInt(counts.insufficientEvidenceCount!) > countBigInt(counts.captureCount!)
    ) {
        return null
    }
    const disclosureStatus = disclosure.status === 'available' || disclosure.status === 'insufficient-samples' ? disclosure.status : null
    if (!disclosureStatus || (disclosureStatus === 'available') !== countAtLeast(counts.measuredCount!, threshold)) return null
    const p50 = captureValue.p50 === null ? null : finite(captureValue.p50)
    const p75 = captureValue.p75 === null ? null : finite(captureValue.p75)
    const p95 = captureValue.p95 === null ? null : finite(captureValue.p95)
    if ([p50, p75, p95].some((item, index) => item === null && [captureValue.p50, captureValue.p75, captureValue.p95][index] !== null)) {
        return null
    }
    if (disclosureStatus === 'available' ? p50 === null || p75 === null || p95 === null : p50 !== null || p75 !== null || p95 !== null) {
        return null
    }
    if (p50 !== null && p75 !== null && p95 !== null && (p50 < 0 || p50 > p75 || p75 > p95)) return null
    return {
        dimensions: { routeKey, release, environment, runtime },
        metric: { metricId: metric.metricId, vitalName: definition.vitalName, unit: definition.unit },
        ...(counts as Omit<AnimationRumV3SummaryGroup, 'dimensions' | 'metric' | 'disclosure' | 'captureValue'>),
        disclosure: { minimumSampleThreshold: threshold, status: disclosureStatus },
        captureValue: { p50, p75, p95 },
    }
}

function parseCapture(value: unknown): AnimationRumV3Capture | null {
    const row = object(value)
    const context = object(row?.context)
    const quality = object(row?.quality)
    const runtime = parseRuntime(context?.runtime)
    if (
        !row ||
        !context ||
        !quality ||
        !runtime ||
        typeof row.eventId !== 'string' ||
        typeof row.captureId !== 'string' ||
        !ID_PATTERN.test(row.eventId) ||
        !ID_PATTERN.test(row.captureId)
    )
        return null
    const routeKey =
        context.routeKey === null
            ? null
            : typeof context.routeKey === 'string' && ROUTE_PATTERN.test(context.routeKey)
              ? context.routeKey
              : undefined
    const metrics = Array.isArray(row.metrics) ? row.metrics.map(parseMetric) : []
    if (
        routeKey === undefined ||
        metrics.length !== 3 ||
        metrics.some(item => item === null) ||
        new Set(metrics.map(item => item!.metricId)).size !== 3
    )
        return null
    const reasons =
        Array.isArray(quality.reasons) && quality.reasons.every(reason => typeof reason === 'string' && QUALITY_REASONS.has(reason))
            ? [...new Set(quality.reasons as string[])]
            : null
    const capturedAt = timestamp(row.capturedAt)
    const receivedAt = timestamp(row.receivedAt)
    const sampleRate = finite(row.sampleRate)
    const samplingPolicyVersion = integer(row.samplingPolicyVersion, 1, 65_535)
    const providerEvidenceCount = integer(row.providerEvidenceCount, 0, 1)
    const metricCount = integer(row.metricCount, 0, 3)
    const visibilityState = closed(context.visibilityState, VISIBILITY)
    const viewportBucket = closed(context.viewportBucket, VIEWPORTS)
    const dprBucket = closed(context.dprBucket, DPR)
    const refreshBudgetSource = closed(context.refreshBudgetSource, REFRESH_SOURCES)
    const refreshBudgetConfidence = closed(context.refreshBudgetConfidence, REFRESH_CONFIDENCES)
    const refreshHz = context.refreshHz === null ? null : finite(context.refreshHz)
    const windowDurationMs = finite(context.windowDurationMs)
    if (
        row.captureKind !== 'soft-navigation' ||
        row.scope !== 'page' ||
        !capturedAt ||
        !receivedAt ||
        typeof row.release !== 'string' ||
        !DEPLOYMENT_PATTERN.test(row.release) ||
        typeof row.dist !== 'string' ||
        !DEPLOYMENT_PATTERN.test(row.dist) ||
        typeof row.environment !== 'string' ||
        !DEPLOYMENT_PATTERN.test(row.environment) ||
        typeof row.sdkVersion !== 'string' ||
        typeof row.monitorVersion !== 'string' ||
        sampleRate === null ||
        sampleRate < 0 ||
        sampleRate > 1 ||
        samplingPolicyVersion === null ||
        !visibilityState ||
        (context.reducedMotion !== null && typeof context.reducedMotion !== 'boolean') ||
        !viewportBucket ||
        !dprBucket ||
        !refreshBudgetSource ||
        !refreshBudgetConfidence ||
        windowDurationMs === null ||
        typeof context.windowDurationCapped !== 'boolean' ||
        (quality.sufficiency !== 'sufficient' && quality.sufficiency !== 'insufficient') ||
        (quality.integrity !== 'complete' && quality.integrity !== 'partial') ||
        !reasons ||
        providerEvidenceCount !== 1 ||
        metricCount !== 3
    ) {
        return null
    }
    return {
        eventId: row.eventId as string,
        captureId: row.captureId as string,
        captureKind: 'soft-navigation',
        scope: 'page',
        capturedAt,
        receivedAt,
        release: row.release,
        dist: row.dist,
        environment: row.environment,
        sdkVersion: row.sdkVersion,
        monitorVersion: row.monitorVersion,
        sampleRate,
        samplingPolicyVersion,
        context: {
            routeKey,
            visibilityState,
            reducedMotion: context.reducedMotion as boolean | null,
            viewportBucket,
            dprBucket,
            refreshHz,
            refreshBudgetSource,
            refreshBudgetConfidence,
            windowDurationMs,
            windowDurationCapped: context.windowDurationCapped,
            runtime,
        },
        quality: { sufficiency: quality.sufficiency, integrity: quality.integrity, reasons },
        providerEvidenceCount,
        metricCount,
        metrics: metrics as AnimationRumV3MetricView[],
    }
}

export function parseAnimationRumV3SummaryResponse(value: unknown): AnimationRumV3SummaryApiResponse | null {
    const root = object(value)
    const data = object(root?.data)
    const window = object(data?.window)
    const captures = object(data?.captures)
    const projection = object(data?.projectionIntegrity)
    const threshold = integer(data?.minimumSampleThreshold, 1, 1_000)
    if (
        root?.success !== true ||
        !data ||
        !window ||
        !captures ||
        !projection ||
        !threshold ||
        data.contractVersion !== 3 ||
        data.snapshotSchemaVersion !== 1 ||
        data.captureKind !== 'soft-navigation'
    )
        return null
    const from = timestamp(window.from)
    const to = timestamp(window.to)
    const captureCounts = {
        total: count(captures.total),
        sufficient: count(captures.sufficient),
        insufficient: count(captures.insufficient),
        partial: count(captures.partial),
    }
    const projectionCounts = {
        completionMarkers: count(projection.completionMarkers),
        verified: count(projection.verified),
        excludedFromAnalytics: count(projection.excludedFromAnalytics),
        metricCountMismatches: count(projection.metricCountMismatches),
        providerEvidenceCountMismatches: count(projection.providerEvidenceCountMismatches),
        childIdentityMismatches: count(projection.childIdentityMismatches),
    }
    const groups = Array.isArray(data.groups) ? data.groups.map(item => parseSummaryGroup(item, threshold)) : []
    if (
        !from ||
        !to ||
        integer(window.retentionDays, 1, 365) === null ||
        typeof window.retentionClamped !== 'boolean' ||
        Object.values(captureCounts).some(item => item === null) ||
        projection.semantics !== 'completion-marker-child-row-counts' ||
        Object.values(projectionCounts).some(item => item === null) ||
        !Array.isArray(data.groups) ||
        groups.some(item => item === null)
    )
        return null
    if (
        countBigInt(projectionCounts.verified!) !== countBigInt(captureCounts.total!) ||
        countBigInt(projectionCounts.completionMarkers!) !==
            countBigInt(projectionCounts.verified!) + countBigInt(projectionCounts.excludedFromAnalytics!) ||
        countBigInt(captureCounts.sufficient!) + countBigInt(captureCounts.insufficient!) !== countBigInt(captureCounts.total!) ||
        countBigInt(captureCounts.partial!) > countBigInt(captureCounts.total!)
    ) {
        return null
    }
    return {
        success: true,
        data: {
            contractVersion: 3,
            snapshotSchemaVersion: 1,
            captureKind: 'soft-navigation',
            minimumSampleThreshold: threshold,
            window: {
                from,
                to,
                retentionDays: window.retentionDays as number,
                retentionClamped: window.retentionClamped,
            },
            captures: captureCounts as AnimationRumV3SummaryApiResponse['data']['captures'],
            projectionIntegrity: {
                semantics: 'completion-marker-child-row-counts',
                ...(projectionCounts as Omit<AnimationRumV3SummaryApiResponse['data']['projectionIntegrity'], 'semantics'>),
            },
            groups: groups as AnimationRumV3SummaryGroup[],
        },
    }
}

export function parseAnimationRumV3CapturesResponse(value: unknown): AnimationRumV3CapturesApiResponse | null {
    const root = object(value)
    const data = object(root?.data)
    const pagination = object(data?.pagination)
    const threshold = integer(data?.minimumSampleThreshold, 1, 1_000)
    if (
        root?.success !== true ||
        !data ||
        !pagination ||
        !threshold ||
        data.contractVersion !== 3 ||
        data.snapshotSchemaVersion !== 1 ||
        data.captureKind !== 'soft-navigation' ||
        !Array.isArray(data.captures)
    )
        return null
    const total = count(pagination.total)
    const limit = integer(pagination.limit, 1, 100)
    const offset = integer(pagination.offset, 0, 100_000)
    const captures = data.captures.map(parseCapture)
    if (
        total === null ||
        limit === null ||
        offset === null ||
        typeof pagination.hasMore !== 'boolean' ||
        captures.some(item => item === null)
    )
        return null
    const consumed = BigInt(offset + captures.length)
    if (captures.length > limit || consumed > BigInt(total) || pagination.hasMore !== consumed < BigInt(total)) return null
    return {
        success: true,
        data: {
            contractVersion: 3,
            snapshotSchemaVersion: 1,
            captureKind: 'soft-navigation',
            minimumSampleThreshold: threshold,
            pagination: { total, limit, offset, hasMore: pagination.hasMore },
            captures: captures as AnimationRumV3Capture[],
        },
    }
}

export function formatAnimationRumV3Count(value: AnimationRumV3Count | null | undefined): string {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未知'
    return typeof value === 'string' && /^\d+$/.test(value) ? value : '未知'
}

export function formatAnimationRumV3Metric(value: number | null, unit: 'ratio' | 'ms'): string {
    if (value === null || !Number.isFinite(value)) return '样本不足 / 未知'
    if (unit === 'ratio') return value.toFixed(value < 0.1 ? 3 : 2)
    return `${value.toFixed(value < 10 ? 1 : 0)} ms`
}

export function animationRumV3MetricStatusLabel(status: AnimationRumV3MetricStatus): string {
    return STATUS_LABELS[status]
}

export function animationRumV3DisclosureLabel(status: 'available' | 'insufficient-samples', threshold: number): string {
    return status === 'available' ? '已达到展示门槛' : `少于 ${threshold} 个已测量采集，隐藏分位值`
}
