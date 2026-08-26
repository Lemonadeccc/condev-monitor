/** Kafka trust-boundary validator for the Animation RUM v1 normalized report. */

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
export type AnimationRumMetric = {
    family: AnimationRumFamily
    name: string
    stat: string
    unit: string
    value: number | null
    samples: number | null
    status: string
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
    context: Record<string, unknown>
    capabilities: Record<string, unknown>
    coverage: Record<string, { status: string; evidenceLevel: string }>
    metrics: AnimationRumMetric[]
}
export type AnimationRumValidationResult = { ok: true; value: AnimationRumV1Report } | { ok: false; errors: string[] }

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
    'monitorVersion',
    'sampleRate',
    'samplingPolicyVersion',
    'context',
    'capabilities',
    'coverage',
    'metrics',
])
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
const STATS = new Set(['latest', 'count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99', 'rate', 'ratio'])
const UNITS = new Set(['ms', 'count', 'ratio', 'bytes', 'pixels', 'hz', 'frames', 'percent'])
const RUNTIMES = new Set(['vanilla', 'react', 'vue', 'svelte', 'solid', 'angular', 'three', 'babylon', 'pixi', 'gsap', 'motion', 'unknown'])
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_BUDGET_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_BUDGET_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const UNAVAILABLE_METRIC_STATUSES = new Set(['not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/
const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const FORBIDDEN = new Set([
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

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function add(errors: string[], code: string): void {
    if (errors.length < 16 && !errors.includes(code)) errors.push(code)
}
function finite(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}
function exactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
    const actual = Object.keys(value)
    return actual.length === keys.size && actual.every(key => keys.has(key))
}
function closedKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
    return Object.keys(value).every(key => keys.has(key))
}
function scan(value: unknown, errors: string[], depth = 0): void {
    if (depth > 4) return
    if (Array.isArray(value)) {
        for (const child of value) scan(child, errors, depth + 1)
    } else if (record(value)) {
        for (const [key, child] of Object.entries(value)) {
            if (FORBIDDEN.has(key.toLowerCase())) add(errors, 'forbidden_field')
            scan(child, errors, depth + 1)
        }
    }
}

export function validateAnimationRumV1(raw: unknown): AnimationRumValidationResult {
    const errors: string[] = []
    if (!record(raw)) return { ok: false, errors: ['invalid_payload'] }
    let bytes = Number.POSITIVE_INFINITY
    try {
        bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8')
    } catch {
        /* fail below */
    }
    if (bytes > 64 * 1024) add(errors, 'payload_too_large')
    scan(raw, errors)
    if (!exactKeys(raw, ROOT_KEYS)) add(errors, 'invalid_root_fields')
    if (raw.contractVersion !== 1) add(errors, 'unsupported_contract_version')
    if (raw.snapshotSchemaVersion !== 1) add(errors, 'unsupported_snapshot_schema_version')
    if (typeof raw.eventId !== 'string' || !ID_RE.test(raw.eventId)) add(errors, 'invalid_event_id')
    if (typeof raw.captureId !== 'string' || !ID_RE.test(raw.captureId)) add(errors, 'invalid_capture_id')
    const capturedTimestamp = Date.parse(String(raw.capturedAt))
    if (typeof raw.capturedAt !== 'string' || !ISO_RE.test(raw.capturedAt) || !Number.isFinite(capturedTimestamp))
        add(errors, 'invalid_captured_at')
    else if (capturedTimestamp < Date.now() - 90 * 24 * 60 * 60 * 1000 || capturedTimestamp > Date.now() + 5 * 60 * 1000)
        add(errors, 'captured_at_out_of_range')
    for (const [key, max, allowEmpty] of [
        ['release', 64, true],
        ['dist', 64, true],
        ['environment', 64, true],
        ['sdkVersion', 64, true],
        ['monitorVersion', 64, false],
    ] as const) {
        const value = raw[key]
        if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value) || (value && !TOKEN_RE.test(value)))
            add(errors, `invalid_${key}`)
    }
    if (!finite(raw.sampleRate, 0.000001, 1)) add(errors, 'invalid_sample_rate')
    if (!Number.isInteger(raw.samplingPolicyVersion) || !finite(raw.samplingPolicyVersion, 1, 255))
        add(errors, 'invalid_sampling_policy_version')

    if (!record(raw.context) || !closedKeys(raw.context, CONTEXT_KEYS)) add(errors, 'invalid_context')
    else {
        if (raw.context.routeKey !== undefined && (typeof raw.context.routeKey !== 'string' || !ROUTE_RE.test(raw.context.routeKey)))
            add(errors, 'invalid_route_key')
        if (
            raw.context.runtimeFamily !== undefined &&
            (typeof raw.context.runtimeFamily !== 'string' || !RUNTIMES.has(raw.context.runtimeFamily))
        )
            add(errors, 'invalid_runtime_family')
        if (
            raw.context.visibilityState !== undefined &&
            (typeof raw.context.visibilityState !== 'string' || !VISIBILITY_STATES.has(raw.context.visibilityState))
        )
            add(errors, 'invalid_visibility_state')
        if (raw.context.reducedMotion !== undefined && raw.context.reducedMotion !== null && typeof raw.context.reducedMotion !== 'boolean')
            add(errors, 'invalid_reduced_motion')
        if (
            raw.context.viewportBucket !== undefined &&
            (typeof raw.context.viewportBucket !== 'string' || !VIEWPORT_BUCKETS.has(raw.context.viewportBucket))
        )
            add(errors, 'invalid_viewport_bucket')
        if (raw.context.dprBucket !== undefined && (typeof raw.context.dprBucket !== 'string' || !DPR_BUCKETS.has(raw.context.dprBucket)))
            add(errors, 'invalid_dpr_bucket')
        if (raw.context.refreshHz !== undefined && raw.context.refreshHz !== null && !finite(raw.context.refreshHz, 1, 1000))
            add(errors, 'invalid_refresh_hz')
        if (
            raw.context.refreshBudgetSource !== undefined &&
            (typeof raw.context.refreshBudgetSource !== 'string' || !REFRESH_BUDGET_SOURCES.has(raw.context.refreshBudgetSource))
        )
            add(errors, 'invalid_refresh_budget_source')
        if (
            raw.context.refreshBudgetConfidence !== undefined &&
            (typeof raw.context.refreshBudgetConfidence !== 'string' ||
                !REFRESH_BUDGET_CONFIDENCES.has(raw.context.refreshBudgetConfidence))
        )
            add(errors, 'invalid_refresh_budget_confidence')
        if (!('windowDurationMs' in raw.context) || !finite(raw.context.windowDurationMs, 0, 604_800_000))
            add(errors, 'invalid_window_duration')
        if (!('windowDurationCapped' in raw.context) || typeof raw.context.windowDurationCapped !== 'boolean')
            add(errors, 'invalid_window_duration_capped')
        if (raw.context.windowDurationCapped === true && raw.context.windowDurationMs !== 604_800_000)
            add(errors, 'invalid_window_duration_cap_semantics')
        if (raw.context.adapterVersions !== undefined) {
            if (!record(raw.context.adapterVersions) || !closedKeys(raw.context.adapterVersions, ADAPTER_KEYS))
                add(errors, 'invalid_adapter_versions')
            else
                for (const value of Object.values(raw.context.adapterVersions))
                    if (typeof value !== 'string' || value.length > 64 || !TOKEN_RE.test(value)) add(errors, 'invalid_adapter_version')
        }
    }
    if (!record(raw.capabilities) || !closedKeys(raw.capabilities, CAPABILITY_KEYS)) add(errors, 'invalid_capabilities')
    else
        for (const value of Object.values(raw.capabilities))
            if (value !== null && value !== 'unknown' && typeof value !== 'boolean') add(errors, 'invalid_capability')

    if (!record(raw.coverage) || !exactKeys(raw.coverage, FAMILY_SET)) add(errors, 'invalid_coverage_families')
    else
        for (const value of Object.values(raw.coverage)) {
            if (!record(value) || !exactKeys(value, new Set(['status', 'evidenceLevel']))) add(errors, 'invalid_coverage')
            else if (
                typeof value.status !== 'string' ||
                !COVERAGE_STATUSES.has(value.status) ||
                typeof value.evidenceLevel !== 'string' ||
                !EVIDENCE_LEVELS.has(value.evidenceLevel)
            )
                add(errors, 'invalid_coverage_value')
        }

    if (!Array.isArray(raw.metrics) || raw.metrics.length < 1 || raw.metrics.length > 128) add(errors, 'invalid_metrics_count')
    else {
        const seen = new Set<string>()
        for (const metric of raw.metrics) {
            if (!record(metric) || !exactKeys(metric, METRIC_KEYS)) {
                add(errors, 'invalid_metric_fields')
                continue
            }
            if (typeof metric.family !== 'string' || !FAMILY_SET.has(metric.family)) add(errors, 'invalid_metric_family')
            if (typeof metric.name !== 'string' || !METRIC_NAMES.has(metric.name)) add(errors, 'invalid_metric_name')
            if (typeof metric.stat !== 'string' || !STATS.has(metric.stat)) add(errors, 'invalid_metric_stat')
            if (typeof metric.unit !== 'string' || !UNITS.has(metric.unit)) add(errors, 'invalid_metric_unit')
            if (
                typeof metric.family === 'string' &&
                typeof metric.name === 'string' &&
                typeof metric.stat === 'string' &&
                typeof metric.unit === 'string' &&
                !METRIC_TUPLES.has([metric.family, metric.name, metric.stat, metric.unit].join('|'))
            )
                add(errors, 'invalid_metric_tuple')
            if (typeof metric.status !== 'string' || !METRIC_STATUSES.has(metric.status)) add(errors, 'invalid_metric_status')
            if (metric.value !== null && !finite(metric.value, 0, 1e15)) add(errors, 'invalid_metric_value')
            if (metric.samples !== null && (!Number.isInteger(metric.samples) || !finite(metric.samples, 0, 1e9)))
                add(errors, 'invalid_metric_samples')
            const unavailable = typeof metric.status === 'string' && UNAVAILABLE_METRIC_STATUSES.has(metric.status)
            if (
                (unavailable && (metric.value !== null || metric.samples !== null)) ||
                (metric.status === 'measured' && (metric.value === null || metric.samples === null))
            )
                add(errors, 'invalid_metric_null_semantics')
            if (typeof metric.family === 'string' && typeof metric.name === 'string' && typeof metric.stat === 'string') {
                const identity = `${metric.family}\0${metric.name}\0${metric.stat}`
                if (seen.has(identity)) add(errors, 'duplicate_metric')
                seen.add(identity)
            }
        }
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: raw as AnimationRumV1Report }
}
