/**
 * Animation RUM wire contract v1.
 *
 * Keep this file dependency-free: the DSN edge and Kafka worker each carry the
 * same validator semantics so an untrusted Kafka producer cannot bypass edge
 * validation. Contract changes must keep the shared golden corpus in
 * apps/backend/shared/animation-rum-v1.golden.ts green at both boundaries.
 */

export const ANIMATION_RUM_EVENT_TYPE = 'animation_rum' as const
export const ANIMATION_RUM_CONTRACT_VERSION = 1 as const
export const ANIMATION_RUM_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const ANIMATION_RUM_MAX_PAYLOAD_BYTES = 64 * 1024
export const ANIMATION_RUM_MAX_METRICS = 128

export const ANIMATION_RUM_FAMILIES = [
    'userOutcome',
    'frameCadence',
    'mainThread',
    'renderingPipeline',
    'renderer',
    'scrollGesture',
    'resourcesMedia',
    'memoryLifecycle',
    'workAvoidance',
    'accessibility',
    'motionQuality',
    'monitorOverhead',
] as const

export type AnimationRumFamily = (typeof ANIMATION_RUM_FAMILIES)[number]
export type AnimationRumCoverageStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported'
export type AnimationRumMetricStatus = AnimationRumCoverageStatus | 'unknown'
export type AnimationRumEvidenceLevel =
    | 'field-measurement'
    | 'controlled-lab-measurement'
    | 'runtime-observation'
    | 'static-candidate'
    | 'unsupported-or-unknown'

export type AnimationRumMetric = {
    family: AnimationRumFamily
    name: string
    stat: 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' | 'rate' | 'ratio'
    unit: 'ms' | 'count' | 'ratio' | 'bytes' | 'pixels' | 'hz' | 'frames' | 'percent'
    value: number | null
    samples: number | null
    status: AnimationRumMetricStatus
}

export type AnimationRumV1Report = {
    contractVersion: 1
    snapshotSchemaVersion: 1
    eventId: string
    captureId: string
    capturedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    context: {
        routeKey?: string
        runtimeFamily?: string
        visibilityState?: 'visible' | 'hidden' | 'prerender' | 'unknown'
        reducedMotion?: boolean | null
        viewportBucket?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'unknown'
        dprBucket?: '1' | '1.5' | '2' | '3' | '4+' | 'unknown'
        refreshHz?: number | null
        refreshBudgetSource?: 'explicit' | 'inferred' | 'observed' | 'unknown'
        refreshBudgetConfidence?: 'explicit' | 'high' | 'medium' | 'low' | 'unknown'
        windowDurationMs: number
        windowDurationCapped: boolean
        adapterVersions?: Partial<
            Record<'framework' | 'renderer' | 'canvas' | 'media' | 'lifecycle' | 'scroll' | 'work' | 'accessibility' | 'motion', string>
        >
    }
    capabilities: Partial<
        Record<
            | 'long-animation-frame'
            | 'longtask'
            | 'event'
            | 'resourceTiming'
            | 'resourceTimingBufferEvents'
            | 'webVitalsAttribution'
            | 'webVitalsSoftNavigation'
            | 'webVitalsDisabled'
            | 'reducedMotionPreference'
            | 'documentAnimationsInspection'
            | 'visibilityLifecycle'
            | 'longAnimationFramePaintTime'
            | 'longAnimationFramePresentationTime',
            boolean | 'unknown' | null
        >
    >
    coverage: Record<AnimationRumFamily, { status: AnimationRumCoverageStatus; evidenceLevel: AnimationRumEvidenceLevel }>
    metrics: AnimationRumMetric[]
}

export type AnimationRumValidationResult = { ok: true; value: AnimationRumV1Report } | { ok: false; errors: string[] }

/**
 * Generic tracking historically accepted arbitrary event type strings. Treat
 * `animation_rum` as the v1 protocol only when version markers are present so
 * an older custom event with the same name keeps its legacy behavior.
 */
export function isAnimationRumV1Candidate(value: unknown): value is Record<string, unknown> {
    return (
        isRecord(value) && value.event_type === ANIMATION_RUM_EVENT_TYPE && ('contractVersion' in value || 'snapshotSchemaVersion' in value)
    )
}

const ROOT_KEYS = new Set([
    'contractVersion',
    'snapshotSchemaVersion',
    'eventId',
    'captureId',
    'capturedAt',
    'release',
    'dist',
    'environment',
    'sdkVersion',
    'sdk_version',
    'monitorVersion',
    'sampleRate',
    'samplingPolicyVersion',
    'context',
    'capabilities',
    'coverage',
    'metrics',
])
const TRACKING_WRAPPER_KEYS = new Set(['event_type', 'message', '_eventId', '_clientCreatedAt'])
const CONTEXT_KEYS = new Set([
    'routeKey',
    'runtimeFamily',
    'visibilityState',
    'reducedMotion',
    'viewportBucket',
    'dprBucket',
    'refreshHz',
    'refreshBudgetSource',
    'refreshBudgetConfidence',
    'windowDurationMs',
    'windowDurationCapped',
    'adapterVersions',
])
const ADAPTER_KEYS = new Set(['framework', 'renderer', 'canvas', 'media', 'lifecycle', 'scroll', 'work', 'accessibility', 'motion'])
const CAPABILITY_KEYS = new Set([
    'long-animation-frame',
    'longtask',
    'event',
    'resourceTiming',
    'resourceTimingBufferEvents',
    'webVitalsAttribution',
    'webVitalsSoftNavigation',
    'webVitalsDisabled',
    'reducedMotionPreference',
    'documentAnimationsInspection',
    'visibilityLifecycle',
    'longAnimationFramePaintTime',
    'longAnimationFramePresentationTime',
])
const METRIC_KEYS = new Set(['family', 'name', 'stat', 'unit', 'value', 'samples', 'status'])
const FAMILY_SET = new Set<string>(ANIMATION_RUM_FAMILIES)
const COVERAGE_STATUSES = new Set(['measured', 'partial', 'not-observed', 'not-instrumented', 'unsupported'])
const METRIC_STATUSES = new Set([...COVERAGE_STATUSES, 'unknown'])
const EVIDENCE_LEVELS = new Set([
    'field-measurement',
    'controlled-lab-measurement',
    'runtime-observation',
    'static-candidate',
    'unsupported-or-unknown',
])
const METRIC_STATS = new Set(['latest', 'count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99', 'rate', 'ratio'])
const METRIC_UNITS = new Set(['ms', 'count', 'ratio', 'bytes', 'pixels', 'hz', 'frames', 'percent'])
const RUNTIME_FAMILIES = new Set([
    'vanilla',
    'react',
    'vue',
    'svelte',
    'solid',
    'angular',
    'three',
    'babylon',
    'pixi',
    'gsap',
    'motion',
    'unknown',
])
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_BUDGET_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_BUDGET_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const UNAVAILABLE_METRIC_STATUSES = new Set(['not-observed', 'not-instrumented', 'unsupported', 'unknown'])

// Metric names are identifiers, not a custom-data channel. Extend deliberately
// when a collector adds a stable metric to the public contract.
const METRIC_NAMES = new Set([
    'CLS',
    'FCP',
    'INP',
    'LCP',
    'TTFB',
    'frameDurationMs',
    'slowFrameRate',
    'droppedFrameRate',
    'jankBurstCount',
    'longestSlowFrameRun',
    'targetFrameMs',
    'inferredRefreshHz',
    'missedFrameOpportunities',
    'longAnimationFrameCount',
    'longAnimationFrameDurationMs',
    'longAnimationFrameBlockingMs',
    'longAnimationFrameScriptDurationMs',
    'longAnimationFrameStyleLayoutTailMs',
    'longTaskCount',
    'longTaskDurationMs',
    'eventTimingDurationMs',
    'inputDelayMs',
    'processingDurationMs',
    'presentationDelayMs',
    'interactionCount',
    'interactionDurationMs',
    'completedInteractions',
    'cancelledInteractions',
    'abandonedInteractions',
    'resourceDurationMs',
    'transferSizeBytes',
    'encodedBodySizeBytes',
    'decodedBodySizeBytes',
    'heapDeltaBytes',
    'heapGrowthBytesPerMinute',
    'runningAnimations',
    'infiniteAnimations',
    'layoutAnimations',
    'paintAnimations',
    'cpuFrameMs',
    'gpuFrameMs',
    'drawCalls',
    'triangles',
    'points',
    'lines',
    'programs',
    'geometries',
    'materials',
    'textures',
    'renderTargets',
    'dpr',
    'backingStorePixels',
    'postProcessingPasses',
    'shaderCompiles',
    'readbacksPerFrame',
    'renderTargetPixelsPerFrame',
    'settledUploadBytesPerFrame',
    'dispatches',
    'computeGpuMs',
    'storageTextureBytes',
    'raycastMs',
    'raycastCandidates',
    'temporaryAllocations',
    'contextLosses',
    'domWebglAlignmentErrorPx',
    'renderedFrames',
    'drawCallSubmissions',
    'readbacks',
    'uploads',
    'presentedFrames',
    'droppedFrames',
    'decodedFrames',
    'videoWidth',
    'videoHeight',
    'fetchToDecodeMs',
    'decodeToUploadMs',
    'uploadToFirstVisibleMs',
    'videoTextureUpdates',
    'loopIterations',
    'soakMinutes',
    'listeners',
    'rafLoops',
    'gsapTickers',
    'activeTickers',
    'scrollTriggers',
    'observers',
    'timelines',
    'canvases',
    'contexts',
    'workers',
    'audioNodes',
    'mediaElements',
    'heapAfterGcBytes',
    'inputToVisualMs',
    'pointerSampleAgeMs',
    'progressError',
    'controlWritersPerFrame',
    'settleTimeMs',
    'overshootRatio',
    'updates',
    'qualityTier',
    'callbackCount',
    'mediaFrames',
    'physicsSteps',
    'dispatchCount',
    'updateCount',
    'uploadBytes',
    'pairedTimingMismatchMs',
    'commitMs',
    'renderMs',
    'hydrationMs',
    'componentsRendered',
    'avoidableRenders',
    'animationDrivenUpdates',
    'mounts',
    'unmounts',
    'reducedMotionViolations',
    'activeAnimationCandidatesUnderReducedMotion',
    'activeWorkSamplesWhileHidden',
    'callbackSelfTimeRatio',
    'reportBuildSelfTimeMs',
    'estimatedSerializedBytes',
])

// v1 is a closed tuple contract, not four independent enum channels. Planned
// adapter names above remain reserved until their complete tuple is promoted.
const METRIC_TUPLES = new Set([
    'frameCadence|frameDurationMs|p50|ms',
    'frameCadence|frameDurationMs|p75|ms',
    'frameCadence|frameDurationMs|p95|ms',
    'frameCadence|frameDurationMs|p99|ms',
    'frameCadence|frameDurationMs|max|ms',
    'frameCadence|targetFrameMs|latest|ms',
    'frameCadence|inferredRefreshHz|latest|hz',
    'frameCadence|slowFrameRate|ratio|ratio',
    'frameCadence|jankBurstCount|count|count',
    'frameCadence|longestSlowFrameRun|max|frames',
    'frameCadence|missedFrameOpportunities|sum|frames',
    'mainThread|longAnimationFrameCount|count|count',
    'mainThread|longAnimationFrameDurationMs|sum|ms',
    'mainThread|longAnimationFrameDurationMs|p95|ms',
    'mainThread|longAnimationFrameBlockingMs|p95|ms',
    'renderingPipeline|longAnimationFrameStyleLayoutTailMs|p95|ms',
    'mainThread|longTaskCount|count|count',
    'mainThread|longTaskDurationMs|sum|ms',
    'mainThread|longTaskDurationMs|p95|ms',
    'mainThread|longTaskDurationMs|max|ms',
    'userOutcome|eventTimingDurationMs|p95|ms',
    'userOutcome|inputDelayMs|p95|ms',
    'userOutcome|processingDurationMs|p95|ms',
    'renderingPipeline|presentationDelayMs|p95|ms',
    'userOutcome|interactionCount|count|count',
    'userOutcome|interactionDurationMs|p95|ms',
    'userOutcome|completedInteractions|count|count',
    'userOutcome|cancelledInteractions|count|count',
    'userOutcome|abandonedInteractions|count|count',
    'monitorOverhead|callbackCount|count|count',
    'monitorOverhead|callbackSelfTimeRatio|ratio|ratio',
    'monitorOverhead|reportBuildSelfTimeMs|p95|ms',
])

const FORBIDDEN_KEYS = new Set([
    'user',
    'userid',
    'useremail',
    'email',
    'ip',
    'ipaddress',
    'useragent',
    'browserinfo',
    'url',
    'href',
    'referrer',
    'referer',
    'selector',
    'selectors',
    'element',
    'dom',
    'frames',
    'rawframes',
    'entries',
    'scripts',
    'resourceurl',
    'sourceurl',
    'custom',
    'customdata',
    'details',
    'metadata',
    'snapshot',
    'events',
    'cookies',
    'headers',
    'authorization',
])

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/
const ROUTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function add(errors: string[], code: string): void {
    if (errors.length < 16 && !errors.includes(code)) errors.push(code)
}

function rejectForbiddenKeys(value: unknown, errors: string[], depth = 0): void {
    if (depth > 4 || errors.length >= 16) return
    if (Array.isArray(value)) {
        for (const item of value) rejectForbiddenKeys(item, errors, depth + 1)
        return
    }
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) add(errors, 'forbidden_field')
        rejectForbiddenKeys(child, errors, depth + 1)
    }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, errors: string[], code: string): void {
    if (Object.keys(value).some(key => !allowed.has(key))) add(errors, code)
}

function boundedString(value: unknown, max: number, pattern?: RegExp, allowEmpty = false): value is string {
    return (
        typeof value === 'string' &&
        value.length <= max &&
        ((allowEmpty && value.length === 0) || (value.length > 0 && (!pattern || pattern.test(value))))
    )
}

function finiteNumber(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function normalizeOptionalString(value: unknown, max: number): string | null {
    if (value === undefined) return ''
    if (!boundedString(value, max, VERSION_RE, true)) return null
    return value
}

function parseContext(raw: unknown, errors: string[]): AnimationRumV1Report['context'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_context')
        return null
    }
    rejectUnknownKeys(raw, CONTEXT_KEYS, errors, 'unknown_context_field')
    if (raw.routeKey !== undefined && !boundedString(raw.routeKey, 128, ROUTE_KEY_RE)) add(errors, 'invalid_route_key')
    if (raw.runtimeFamily !== undefined && (!boundedString(raw.runtimeFamily, 24) || !RUNTIME_FAMILIES.has(raw.runtimeFamily))) {
        add(errors, 'invalid_runtime_family')
    }
    if (raw.visibilityState !== undefined && (typeof raw.visibilityState !== 'string' || !VISIBILITY_STATES.has(raw.visibilityState))) {
        add(errors, 'invalid_visibility_state')
    }
    if (raw.reducedMotion !== undefined && raw.reducedMotion !== null && typeof raw.reducedMotion !== 'boolean')
        add(errors, 'invalid_reduced_motion')
    if (raw.viewportBucket !== undefined && (typeof raw.viewportBucket !== 'string' || !VIEWPORT_BUCKETS.has(raw.viewportBucket))) {
        add(errors, 'invalid_viewport_bucket')
    }
    if (raw.dprBucket !== undefined && (typeof raw.dprBucket !== 'string' || !DPR_BUCKETS.has(raw.dprBucket)))
        add(errors, 'invalid_dpr_bucket')
    if (raw.refreshHz !== undefined && raw.refreshHz !== null && !finiteNumber(raw.refreshHz, 1, 1000)) add(errors, 'invalid_refresh_hz')
    if (
        raw.refreshBudgetSource !== undefined &&
        (typeof raw.refreshBudgetSource !== 'string' || !REFRESH_BUDGET_SOURCES.has(raw.refreshBudgetSource))
    ) {
        add(errors, 'invalid_refresh_budget_source')
    }
    if (
        raw.refreshBudgetConfidence !== undefined &&
        (typeof raw.refreshBudgetConfidence !== 'string' || !REFRESH_BUDGET_CONFIDENCES.has(raw.refreshBudgetConfidence))
    ) {
        add(errors, 'invalid_refresh_budget_confidence')
    }
    if (!('windowDurationMs' in raw) || !finiteNumber(raw.windowDurationMs, 0, 604_800_000)) {
        add(errors, 'invalid_window_duration')
    }
    if (!('windowDurationCapped' in raw) || typeof raw.windowDurationCapped !== 'boolean') {
        add(errors, 'invalid_window_duration_capped')
    }
    if (raw.windowDurationCapped === true && raw.windowDurationMs !== 604_800_000) {
        add(errors, 'invalid_window_duration_cap_semantics')
    }
    if (raw.adapterVersions !== undefined) {
        if (!isRecord(raw.adapterVersions)) add(errors, 'invalid_adapter_versions')
        else {
            rejectUnknownKeys(raw.adapterVersions, ADAPTER_KEYS, errors, 'unknown_adapter_field')
            for (const version of Object.values(raw.adapterVersions)) {
                if (!boundedString(version, 64, VERSION_RE)) add(errors, 'invalid_adapter_version')
            }
        }
    }
    return raw as AnimationRumV1Report['context']
}

function parseCapabilities(raw: unknown, errors: string[]): AnimationRumV1Report['capabilities'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_capabilities')
        return null
    }
    rejectUnknownKeys(raw, CAPABILITY_KEYS, errors, 'unknown_capability')
    for (const value of Object.values(raw)) {
        if (value !== null && value !== 'unknown' && typeof value !== 'boolean') add(errors, 'invalid_capability_value')
    }
    return raw as AnimationRumV1Report['capabilities']
}

function parseCoverage(raw: unknown, errors: string[]): AnimationRumV1Report['coverage'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_coverage')
        return null
    }
    const families = Object.keys(raw)
    if (families.some(key => !FAMILY_SET.has(key))) add(errors, 'unknown_coverage_family')
    if (families.length !== ANIMATION_RUM_FAMILIES.length || ANIMATION_RUM_FAMILIES.some(family => !(family in raw))) {
        add(errors, 'missing_coverage_family')
    }
    for (const value of Object.values(raw)) {
        if (!isRecord(value)) {
            add(errors, 'invalid_coverage_value')
            continue
        }
        rejectUnknownKeys(value, new Set(['status', 'evidenceLevel']), errors, 'unknown_coverage_field')
        if (typeof value.status !== 'string' || !COVERAGE_STATUSES.has(value.status)) add(errors, 'invalid_coverage_status')
        if (typeof value.evidenceLevel !== 'string' || !EVIDENCE_LEVELS.has(value.evidenceLevel)) add(errors, 'invalid_evidence_level')
    }
    return raw as AnimationRumV1Report['coverage']
}

function parseMetrics(raw: unknown, errors: string[]): AnimationRumMetric[] | null {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > ANIMATION_RUM_MAX_METRICS) {
        add(errors, 'invalid_metrics_count')
        return null
    }
    const identities = new Set<string>()
    for (const metric of raw) {
        if (!isRecord(metric)) {
            add(errors, 'invalid_metric')
            continue
        }
        rejectUnknownKeys(metric, METRIC_KEYS, errors, 'unknown_metric_field')
        if (Object.keys(metric).length !== METRIC_KEYS.size) add(errors, 'missing_metric_field')
        if (typeof metric.family !== 'string' || !FAMILY_SET.has(metric.family)) add(errors, 'invalid_metric_family')
        if (typeof metric.name !== 'string' || !METRIC_NAMES.has(metric.name)) add(errors, 'invalid_metric_name')
        if (typeof metric.stat !== 'string' || !METRIC_STATS.has(metric.stat)) add(errors, 'invalid_metric_stat')
        if (typeof metric.unit !== 'string' || !METRIC_UNITS.has(metric.unit)) add(errors, 'invalid_metric_unit')
        if (
            typeof metric.family === 'string' &&
            typeof metric.name === 'string' &&
            typeof metric.stat === 'string' &&
            typeof metric.unit === 'string' &&
            !METRIC_TUPLES.has([metric.family, metric.name, metric.stat, metric.unit].join('|'))
        ) {
            add(errors, 'invalid_metric_tuple')
        }
        if (typeof metric.status !== 'string' || !METRIC_STATUSES.has(metric.status)) add(errors, 'invalid_metric_status')
        if (metric.value !== null && !finiteNumber(metric.value, 0, 1e15)) add(errors, 'invalid_metric_value')
        if (metric.samples !== null && (!Number.isInteger(metric.samples) || !finiteNumber(metric.samples, 0, 1e9)))
            add(errors, 'invalid_metric_samples')
        const unavailable = typeof metric.status === 'string' && UNAVAILABLE_METRIC_STATUSES.has(metric.status)
        if (
            (unavailable && (metric.value !== null || metric.samples !== null)) ||
            (metric.status === 'measured' && (metric.value === null || metric.samples === null))
        )
            add(errors, 'invalid_metric_null_semantics')
        if (typeof metric.family === 'string' && typeof metric.name === 'string' && typeof metric.stat === 'string') {
            const identity = `${metric.family}\0${metric.name}\0${metric.stat}`
            if (identities.has(identity)) add(errors, 'duplicate_metric')
            identities.add(identity)
        }
    }
    return raw as AnimationRumMetric[]
}

export function validateAnimationRumV1(raw: unknown, options: { trackingWrapper?: boolean } = {}): AnimationRumValidationResult {
    const errors: string[] = []
    if (!isRecord(raw)) return { ok: false, errors: ['invalid_payload'] }

    let size = Number.POSITIVE_INFINITY
    try {
        size = Buffer.byteLength(JSON.stringify(raw), 'utf8')
    } catch {
        // Circular/non-serializable request bodies cannot be valid wire payloads.
    }
    if (size > ANIMATION_RUM_MAX_PAYLOAD_BYTES) add(errors, 'payload_too_large')
    rejectForbiddenKeys(raw, errors)
    rejectUnknownKeys(
        raw,
        options.trackingWrapper ? new Set([...ROOT_KEYS, ...TRACKING_WRAPPER_KEYS]) : ROOT_KEYS,
        errors,
        'unknown_root_field'
    )

    if (options.trackingWrapper) {
        if (raw.event_type !== ANIMATION_RUM_EVENT_TYPE) add(errors, 'invalid_event_type')
        if (raw.message !== undefined && raw.message !== '' && raw.message !== ANIMATION_RUM_EVENT_TYPE) add(errors, 'invalid_message')
    }
    if (raw.contractVersion !== ANIMATION_RUM_CONTRACT_VERSION) add(errors, 'unsupported_contract_version')
    if (raw.snapshotSchemaVersion !== ANIMATION_RUM_SNAPSHOT_SCHEMA_VERSION) add(errors, 'unsupported_snapshot_schema_version')

    const eventId = raw.eventId ?? raw._eventId
    if (!boundedString(eventId, 80, ID_RE)) add(errors, 'invalid_event_id')
    if (raw.eventId !== undefined && raw._eventId !== undefined && raw.eventId !== raw._eventId) add(errors, 'event_id_mismatch')
    if (!boundedString(raw.captureId, 80, ID_RE)) add(errors, 'invalid_capture_id')
    const capturedTimestamp = Date.parse(String(raw.capturedAt))
    if (!boundedString(raw.capturedAt, 40, ISO_UTC_RE) || !Number.isFinite(capturedTimestamp)) add(errors, 'invalid_captured_at')
    else if (capturedTimestamp < Date.now() - 90 * 24 * 60 * 60 * 1000 || capturedTimestamp > Date.now() + 5 * 60 * 1000) {
        add(errors, 'captured_at_out_of_range')
    }
    if (raw._clientCreatedAt !== undefined && !finiteNumber(raw._clientCreatedAt, 0, Number.MAX_SAFE_INTEGER))
        add(errors, 'invalid_client_created_at')

    const release = normalizeOptionalString(raw.release, 64)
    const dist = normalizeOptionalString(raw.dist, 64)
    const environment = normalizeOptionalString(raw.environment, 64)
    const sdkVersion = normalizeOptionalString(raw.sdkVersion ?? raw.sdk_version, 64)
    if (release === null) add(errors, 'invalid_release')
    if (dist === null) add(errors, 'invalid_dist')
    if (environment === null) add(errors, 'invalid_environment')
    if (sdkVersion === null) add(errors, 'invalid_sdk_version')
    if (raw.sdkVersion !== undefined && raw.sdk_version !== undefined && raw.sdkVersion !== raw.sdk_version)
        add(errors, 'sdk_version_mismatch')
    if (!boundedString(raw.monitorVersion, 64, VERSION_RE)) add(errors, 'invalid_monitor_version')
    if (!finiteNumber(raw.sampleRate, 0.000001, 1)) add(errors, 'invalid_sample_rate')
    if (!Number.isInteger(raw.samplingPolicyVersion) || !finiteNumber(raw.samplingPolicyVersion, 1, 255))
        add(errors, 'invalid_sampling_policy_version')

    const context = parseContext(raw.context, errors)
    const capabilities = parseCapabilities(raw.capabilities, errors)
    const coverage = parseCoverage(raw.coverage, errors)
    const metrics = parseMetrics(raw.metrics, errors)

    if (
        errors.length > 0 ||
        !context ||
        !capabilities ||
        !coverage ||
        !metrics ||
        release === null ||
        dist === null ||
        environment === null ||
        sdkVersion === null
    ) {
        return { ok: false, errors }
    }

    return {
        ok: true,
        value: {
            contractVersion: 1,
            snapshotSchemaVersion: 1,
            eventId: eventId as string,
            captureId: raw.captureId as string,
            capturedAt: raw.capturedAt as string,
            release,
            dist,
            environment,
            sdkVersion,
            monitorVersion: raw.monitorVersion as string,
            sampleRate: raw.sampleRate as number,
            samplingPolicyVersion: raw.samplingPolicyVersion as number,
            context,
            capabilities,
            coverage,
            metrics,
        },
    }
}
