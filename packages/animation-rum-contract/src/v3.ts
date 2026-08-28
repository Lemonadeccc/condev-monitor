// cspell:ignore componentname domid elementid interactionid navigationid navigationurl noncanonical ownerlabel rawsamples segmentid startedat textcontent
import { type AnimationRumV2CapabilityState, type AnimationRumV2Report, isAnimationRumV2RouteKey } from './v2'

export const ANIMATION_RUM_V3_CONTRACT_VERSION = 3 as const
export const ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const ANIMATION_RUM_V3_CAPTURE_KIND = 'soft-navigation' as const
export const ANIMATION_RUM_V3_EVIDENCE_WINDOW = 'soft-navigation-lifetime' as const
export const ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES = 64 * 1024
export const ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS = 604_800_000
export const ANIMATION_RUM_V3_CAPABILITY = 'web-vitals-soft-navigation' as const
export const ANIMATION_RUM_V3_PROVIDER_OWNER = 'web-vitals-runtime' as const

export type AnimationRumV3VitalName = 'CLS' | 'INP' | 'LCP'
export type AnimationRumV3MetricId =
    | 'vital.soft-navigation.cls.latest'
    | 'vital.soft-navigation.inp.latest'
    | 'vital.soft-navigation.lcp.latest'
export type AnimationRumV3MetricStatus = 'measured' | 'partial' | 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
export type AnimationRumV3QualityReason = 'provider-rejected-samples' | 'provider-truncated' | 'source-field-incomplete' | 'window-capped'

export interface AnimationRumV3MetricDefinition {
    readonly metricId: AnimationRumV3MetricId
    readonly vitalName: AnimationRumV3VitalName
    readonly unit: 'ratio' | 'ms'
    readonly evidenceWindow: typeof ANIMATION_RUM_V3_EVIDENCE_WINDOW
    readonly relation: 'page-window'
    readonly owner: typeof ANIMATION_RUM_V3_PROVIDER_OWNER
    readonly requiredCapability: typeof ANIMATION_RUM_V3_CAPABILITY
}

function metric(
    metricId: AnimationRumV3MetricId,
    vitalName: AnimationRumV3VitalName,
    unit: AnimationRumV3MetricDefinition['unit']
): AnimationRumV3MetricDefinition {
    return Object.freeze({
        metricId,
        vitalName,
        unit,
        evidenceWindow: ANIMATION_RUM_V3_EVIDENCE_WINDOW,
        relation: 'page-window',
        owner: ANIMATION_RUM_V3_PROVIDER_OWNER,
        requiredCapability: ANIMATION_RUM_V3_CAPABILITY,
    })
}

export const ANIMATION_RUM_V3_METRIC_CATALOG: readonly AnimationRumV3MetricDefinition[] = Object.freeze([
    metric('vital.soft-navigation.cls.latest', 'CLS', 'ratio'),
    metric('vital.soft-navigation.inp.latest', 'INP', 'ms'),
    metric('vital.soft-navigation.lcp.latest', 'LCP', 'ms'),
])

export interface AnimationRumV3ProviderEvidence {
    version: string
    /** Number of final metric values accepted for this completed segment. */
    accepted: number
    /** v3 requires retained === accepted. */
    retained: number
    /** Number of non-null final metric rows; v3 requires evidence === retained. */
    evidence: number
    /** Source observer entries lost before validation. */
    dropped: number
    /** Source updates rejected as malformed or inconsistent. */
    rejected: number
    /** Exactly reflects whether dropped is non-zero. */
    truncated: boolean
}

export interface AnimationRumV3Metric {
    metricId: AnimationRumV3MetricId
    relation: 'page-window'
    owner: typeof ANIMATION_RUM_V3_PROVIDER_OWNER
    value: number | null
    samples: 1 | null
    status: AnimationRumV3MetricStatus
}

export interface AnimationRumV3SoftNavigationCapability {
    status: AnimationRumV2CapabilityState
    metrics: Record<AnimationRumV3VitalName, AnimationRumV2CapabilityState>
}

export interface AnimationRumV3Context {
    routeKey: string
    visibilityState?: AnimationRumV2Report['context']['visibilityState']
    reducedMotion?: AnimationRumV2Report['context']['reducedMotion']
    viewportBucket?: AnimationRumV2Report['context']['viewportBucket']
    dprBucket?: AnimationRumV2Report['context']['dprBucket']
    refreshHz?: AnimationRumV2Report['context']['refreshHz']
    refreshBudgetSource?: AnimationRumV2Report['context']['refreshBudgetSource']
    refreshBudgetConfidence?: AnimationRumV2Report['context']['refreshBudgetConfidence']
    windowDurationMs: number
    windowDurationCapped: boolean
    runtime: AnimationRumV2Report['context']['runtime']
}

export interface AnimationRumV3Report {
    contractVersion: 3
    snapshotSchemaVersion: 1
    captureKind: typeof ANIMATION_RUM_V3_CAPTURE_KIND
    eventId: string
    captureId: string
    scope: 'page'
    parentCaptureId: null
    targetKey: null
    capturedAt: string
    release: string
    dist: string
    environment: string
    sdkVersion: string
    monitorVersion: string
    sampleRate: number
    samplingPolicyVersion: number
    context: AnimationRumV3Context
    capabilities: Record<typeof ANIMATION_RUM_V3_CAPABILITY, AnimationRumV3SoftNavigationCapability>
    coverage: {
        userOutcome: {
            status: AnimationRumV3MetricStatus
            evidenceLevel: 'runtime-observation' | 'unsupported-or-unknown'
        }
    }
    captureQuality: {
        sufficiency: 'sufficient' | 'insufficient'
        integrity: 'complete' | 'partial'
        reasons: AnimationRumV3QualityReason[]
    }
    providerEvidence: {
        'web-vitals-runtime': {
            userOutcome: AnimationRumV3ProviderEvidence
        }
    }
    metrics: [AnimationRumV3Metric, AnimationRumV3Metric, AnimationRumV3Metric]
}

export type AnimationRumV3ValidationResult = { ok: true; value: AnimationRumV3Report } | { ok: false; errors: string[] }

const MAX_VALIDATION_ERRORS = 64
const REQUIRED_CONTEXT_KEYS = ['routeKey', 'windowDurationMs', 'windowDurationCapped', 'runtime'] as const
const ROOT_KEYS = new Set([
    'contractVersion',
    'snapshotSchemaVersion',
    'captureKind',
    'eventId',
    'captureId',
    'scope',
    'parentCaptureId',
    'targetKey',
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
    'captureQuality',
    'providerEvidence',
    'metrics',
])
const CONTEXT_KEYS = new Set([
    'routeKey',
    'visibilityState',
    'reducedMotion',
    'viewportBucket',
    'dprBucket',
    'refreshHz',
    'refreshBudgetSource',
    'refreshBudgetConfidence',
    'windowDurationMs',
    'windowDurationCapped',
    'runtime',
])
const RUNTIME_KEYS = new Set(['framework', 'renderer', 'backend'])
const CAPABILITY_KEYS = new Set([ANIMATION_RUM_V3_CAPABILITY])
const CAPABILITY_VALUE_KEYS = new Set(['status', 'metrics'])
const CAPABILITY_METRIC_KEYS = new Set<AnimationRumV3VitalName>(['CLS', 'INP', 'LCP'])
const COVERAGE_KEYS = new Set(['userOutcome'])
const COVERAGE_VALUE_KEYS = new Set(['status', 'evidenceLevel'])
const QUALITY_KEYS = new Set(['sufficiency', 'integrity', 'reasons'])
const PROVIDER_OWNER_KEYS = new Set([ANIMATION_RUM_V3_PROVIDER_OWNER])
const PROVIDER_FAMILY_KEYS = new Set(['userOutcome'])
const PROVIDER_KEYS = new Set(['version', 'accepted', 'retained', 'evidence', 'dropped', 'rejected', 'truncated'])
const METRIC_KEYS = new Set(['metricId', 'relation', 'owner', 'value', 'samples', 'status'])
const CAPABILITY_STATES = new Set<AnimationRumV2CapabilityState>(['supported', 'unsupported', 'unknown', 'disabled'])
const AVAILABLE_STATUSES = new Set<AnimationRumV3MetricStatus>(['measured', 'partial'])
const UNAVAILABLE_STATUSES = new Set<AnimationRumV3MetricStatus>(['not-observed', 'not-instrumented', 'unsupported', 'unknown'])
const QUALITY_REASONS = new Set<AnimationRumV3QualityReason>([
    'provider-rejected-samples',
    'provider-truncated',
    'source-field-incomplete',
    'window-capped',
])
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unknown'])
const VIEWPORT_BUCKETS = new Set(['tiny', 'small', 'medium', 'large', 'xlarge', 'unknown'])
const DPR_BUCKETS = new Set(['1', '1.5', '2', '3', '4+', 'unknown'])
const REFRESH_SOURCES = new Set(['explicit', 'inferred', 'observed', 'unknown'])
const REFRESH_CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const FRAMEWORKS = new Set(['vanilla', 'react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'mixed', 'other', 'unknown'])
const RENDERERS = new Set(['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'])
const BACKENDS = new Set(['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'])
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u
const PROVIDER_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z][a-z0-9.-]{0,23})?$/u
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u
const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u
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
    'navigationurl',
    'href',
    'path',
    'pathname',
    'referrer',
    'referer',
    'query',
    'hash',
    'selector',
    'selectors',
    'element',
    'elementid',
    'dom',
    'domid',
    'class',
    'classname',
    'tag',
    'tagname',
    'role',
    'text',
    'innertext',
    'textcontent',
    'input',
    'inputvalue',
    'props',
    'state',
    'component',
    'componentname',
    'ownerlabel',
    'source',
    'sourcefile',
    'file',
    'line',
    'column',
    'stack',
    'frames',
    'rawframes',
    'rawsamples',
    'entries',
    'events',
    'scripts',
    'keyframes',
    'resourcename',
    'resourceurl',
    'navigationid',
    'interactionid',
    'starttime',
    'startedat',
    'segmentid',
    'details',
    'metadata',
    'snapshot',
    'cookies',
    'headers',
    'authorization',
])

function isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function add(errors: string[], code: string): void {
    if (errors.length < MAX_VALIDATION_ERRORS && !errors.includes(code)) errors.push(code)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, errors: string[], code: string): void {
    if (Object.keys(value).some(key => !allowed.has(key))) add(errors, code)
}

function rejectForbiddenKeys(value: unknown, errors: string[], depth = 0): void {
    if (depth > 12 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
        for (const item of value) rejectForbiddenKeys(item, errors, depth + 1)
        return
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) add(errors, 'forbidden_field')
        rejectForbiddenKeys(nested, errors, depth + 1)
    }
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function boundedInteger(value: unknown, maximum = 1_000_000_000): value is number {
    return Number.isInteger(value) && finiteNumber(value, 0, maximum)
}

function boundedString(value: unknown, maximum: number, pattern: RegExp, allowEmpty = false): value is string {
    return (
        typeof value === 'string' &&
        value.length <= maximum &&
        (allowEmpty || value.length > 0) &&
        (value.length === 0 || pattern.test(value))
    )
}

function payloadBytes(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength
    } catch {
        return Number.POSITIVE_INFINITY
    }
}

function canonicalUtcTimestamp(value: unknown): number | null {
    if (!boundedString(value, 40, ISO_UTC_RE)) return null
    const match = ISO_UTC_RE.exec(value)
    if (!match) return null
    const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized ? timestamp : null
}

function expectedUnavailableStatus(
    capability: AnimationRumV2CapabilityState
): Extract<AnimationRumV3MetricStatus, 'not-instrumented' | 'unsupported' | 'unknown'> | null {
    if (capability === 'disabled') return 'not-instrumented'
    if (capability === 'unsupported') return 'unsupported'
    if (capability === 'unknown') return 'unknown'
    return null
}

function expectedCapabilityStatus(metrics: Record<AnimationRumV3VitalName, AnimationRumV2CapabilityState>): AnimationRumV2CapabilityState {
    const states = Object.values(metrics)
    if (states.some(state => state === 'supported')) return 'supported'
    if (states.every(state => state === 'disabled')) return 'disabled'
    if (states.every(state => state === 'unsupported')) return 'unsupported'
    return 'unknown'
}

function parseContext(raw: unknown, errors: string[]): AnimationRumV3Context | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_context')
        return null
    }
    rejectUnknownKeys(raw, CONTEXT_KEYS, errors, 'unknown_context_field')
    if (REQUIRED_CONTEXT_KEYS.some(key => !(key in raw))) add(errors, 'missing_context_field')
    if (!isAnimationRumV2RouteKey(raw.routeKey)) add(errors, 'invalid_route_key')
    if (!finiteNumber(raw.windowDurationMs, 0, ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS)) add(errors, 'invalid_window_duration')
    if (typeof raw.windowDurationCapped !== 'boolean') add(errors, 'invalid_window_duration_capped')
    if (raw.windowDurationCapped === true && raw.windowDurationMs !== ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS) {
        add(errors, 'invalid_window_duration_cap_semantics')
    }
    if (raw.visibilityState !== undefined && !VISIBILITY_STATES.has(raw.visibilityState as string)) add(errors, 'invalid_visibility_state')
    if (raw.reducedMotion !== undefined && raw.reducedMotion !== null && typeof raw.reducedMotion !== 'boolean') {
        add(errors, 'invalid_reduced_motion')
    }
    if (raw.viewportBucket !== undefined && !VIEWPORT_BUCKETS.has(raw.viewportBucket as string)) add(errors, 'invalid_viewport_bucket')
    if (raw.dprBucket !== undefined && !DPR_BUCKETS.has(raw.dprBucket as string)) add(errors, 'invalid_dpr_bucket')
    if (raw.refreshHz !== undefined && raw.refreshHz !== null && !finiteNumber(raw.refreshHz, 1, 1_000)) add(errors, 'invalid_refresh_hz')
    if (raw.refreshBudgetSource !== undefined && !REFRESH_SOURCES.has(raw.refreshBudgetSource as string)) {
        add(errors, 'invalid_refresh_budget_source')
    }
    if (raw.refreshBudgetConfidence !== undefined && !REFRESH_CONFIDENCES.has(raw.refreshBudgetConfidence as string)) {
        add(errors, 'invalid_refresh_budget_confidence')
    }
    if (!isRecord(raw.runtime)) add(errors, 'invalid_runtime')
    else {
        rejectUnknownKeys(raw.runtime, RUNTIME_KEYS, errors, 'unknown_runtime_field')
        if (Object.keys(raw.runtime).length !== RUNTIME_KEYS.size) add(errors, 'missing_runtime_field')
        if (!FRAMEWORKS.has(raw.runtime.framework as string)) add(errors, 'invalid_runtime_framework')
        if (!RENDERERS.has(raw.runtime.renderer as string)) add(errors, 'invalid_runtime_renderer')
        if (!BACKENDS.has(raw.runtime.backend as string)) add(errors, 'invalid_runtime_backend')
    }
    return raw as unknown as AnimationRumV3Context
}

function parseCapabilities(raw: unknown, errors: string[]): AnimationRumV3SoftNavigationCapability | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_capabilities')
        return null
    }
    rejectUnknownKeys(raw, CAPABILITY_KEYS, errors, 'unknown_capability')
    if (Object.keys(raw).length !== 1 || !isRecord(raw[ANIMATION_RUM_V3_CAPABILITY])) {
        add(errors, 'missing_capability')
        return null
    }
    const capability = raw[ANIMATION_RUM_V3_CAPABILITY]
    rejectUnknownKeys(capability, CAPABILITY_VALUE_KEYS, errors, 'unknown_capability_field')
    if (Object.keys(capability).length !== CAPABILITY_VALUE_KEYS.size) add(errors, 'missing_capability_field')
    const status = capability.status
    if (typeof status !== 'string' || !CAPABILITY_STATES.has(status as AnimationRumV2CapabilityState)) {
        add(errors, 'invalid_capability_state')
    }
    if (!isRecord(capability.metrics)) {
        add(errors, 'invalid_metric_capabilities')
        return null
    }
    rejectUnknownKeys(capability.metrics, CAPABILITY_METRIC_KEYS, errors, 'unknown_metric_capability')
    if (Object.keys(capability.metrics).length !== CAPABILITY_METRIC_KEYS.size) add(errors, 'missing_metric_capability')
    for (const name of CAPABILITY_METRIC_KEYS) {
        if (!CAPABILITY_STATES.has(capability.metrics[name] as AnimationRumV2CapabilityState))
            add(errors, 'invalid_metric_capability_state')
    }
    const parsed = capability as unknown as AnimationRumV3SoftNavigationCapability
    if (CAPABILITY_STATES.has(status as AnimationRumV2CapabilityState) && status !== expectedCapabilityStatus(parsed.metrics)) {
        add(errors, 'invalid_capability_summary')
    }
    return parsed
}

function parseProviderEvidence(raw: unknown, errors: string[]): AnimationRumV3ProviderEvidence | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_provider_evidence')
        return null
    }
    rejectUnknownKeys(raw, PROVIDER_OWNER_KEYS, errors, 'unknown_provider_owner')
    if (Object.keys(raw).length !== 1 || !isRecord(raw[ANIMATION_RUM_V3_PROVIDER_OWNER])) {
        add(errors, 'missing_provider_owner')
        return null
    }
    const families = raw[ANIMATION_RUM_V3_PROVIDER_OWNER]
    rejectUnknownKeys(families, PROVIDER_FAMILY_KEYS, errors, 'unknown_provider_family')
    if (Object.keys(families).length !== 1 || !isRecord(families.userOutcome)) {
        add(errors, 'missing_provider_family')
        return null
    }
    const provider = families.userOutcome
    rejectUnknownKeys(provider, PROVIDER_KEYS, errors, 'unknown_provider_evidence_field')
    if (Object.keys(provider).length !== PROVIDER_KEYS.size) add(errors, 'missing_provider_evidence_field')
    if (!boundedString(provider.version, 32, PROVIDER_VERSION_RE)) add(errors, 'invalid_provider_version')
    for (const key of ['accepted', 'retained', 'evidence'] as const) {
        if (!boundedInteger(provider[key], ANIMATION_RUM_V3_METRIC_CATALOG.length)) add(errors, 'invalid_provider_count')
    }
    for (const key of ['dropped', 'rejected'] as const) {
        if (!boundedInteger(provider[key])) add(errors, 'invalid_provider_count')
    }
    if (typeof provider.truncated !== 'boolean') add(errors, 'invalid_provider_truncated')
    if (boundedInteger(provider.accepted, 3) && boundedInteger(provider.retained, 3) && boundedInteger(provider.evidence, 3)) {
        if (provider.accepted !== provider.retained || provider.retained !== provider.evidence) {
            add(errors, 'invalid_provider_count_semantics')
        }
    }
    if (boundedInteger(provider.dropped) && typeof provider.truncated === 'boolean' && provider.truncated !== provider.dropped > 0) {
        add(errors, 'invalid_provider_truncated_semantics')
    }
    return provider as unknown as AnimationRumV3ProviderEvidence
}

function parseQualityReasons(raw: unknown, errors: string[]): AnimationRumV3QualityReason[] | null {
    if (!Array.isArray(raw) || raw.length > QUALITY_REASONS.size) {
        add(errors, 'invalid_capture_quality_reasons')
        return null
    }
    if (raw.some(reason => typeof reason !== 'string' || !QUALITY_REASONS.has(reason as AnimationRumV3QualityReason))) {
        add(errors, 'invalid_capture_quality_reason')
        return null
    }
    const reasons = raw as AnimationRumV3QualityReason[]
    if (new Set(reasons).size !== reasons.length || reasons.join('\0') !== [...reasons].sort().join('\0')) {
        add(errors, 'noncanonical_capture_quality_reasons')
    }
    return reasons
}

function parseCaptureQuality(
    raw: unknown,
    context: AnimationRumV3Context | null,
    capability: AnimationRumV3SoftNavigationCapability | null,
    provider: AnimationRumV3ProviderEvidence | null,
    errors: string[]
): AnimationRumV3Report['captureQuality'] | null {
    if (!isRecord(raw)) {
        add(errors, 'invalid_capture_quality')
        return null
    }
    rejectUnknownKeys(raw, QUALITY_KEYS, errors, 'unknown_capture_quality_field')
    if (Object.keys(raw).length !== QUALITY_KEYS.size) add(errors, 'missing_capture_quality_field')
    if (raw.sufficiency !== 'sufficient' && raw.sufficiency !== 'insufficient') add(errors, 'invalid_capture_sufficiency')
    if (raw.integrity !== 'complete' && raw.integrity !== 'partial') add(errors, 'invalid_capture_integrity')
    const reasons = parseQualityReasons(raw.reasons, errors)
    if (reasons) {
        const facts = new Map<AnimationRumV3QualityReason, boolean>([
            ['provider-rejected-samples', (provider?.rejected ?? 0) > 0],
            ['provider-truncated', provider?.truncated === true || (provider?.dropped ?? 0) > 0],
            ['source-field-incomplete', capability ? Object.values(capability.metrics).includes('unknown') : false],
            ['window-capped', context?.windowDurationCapped === true],
        ])
        for (const [reason, fact] of facts) {
            if (reasons.includes(reason) !== fact) add(errors, 'invalid_capture_quality_fact')
        }
        if (raw.integrity !== (reasons.length > 0 ? 'partial' : 'complete')) add(errors, 'invalid_capture_integrity_semantics')
    }
    return raw as unknown as AnimationRumV3Report['captureQuality']
}

function parseMetrics(
    raw: unknown,
    capability: AnimationRumV3SoftNavigationCapability | null,
    provider: AnimationRumV3ProviderEvidence | null,
    qualityReasons: readonly AnimationRumV3QualityReason[] | null,
    errors: string[]
): AnimationRumV3Report['metrics'] | null {
    if (!Array.isArray(raw) || raw.length !== ANIMATION_RUM_V3_METRIC_CATALOG.length) {
        add(errors, 'invalid_metrics_count')
        return null
    }
    let availableMetricCount = 0
    for (let index = 0; index < ANIMATION_RUM_V3_METRIC_CATALOG.length; index += 1) {
        const value = raw[index]
        const expected = ANIMATION_RUM_V3_METRIC_CATALOG[index]!
        if (!isRecord(value)) {
            add(errors, 'invalid_metric')
            continue
        }
        rejectUnknownKeys(value, METRIC_KEYS, errors, 'unknown_metric_field')
        if (Object.keys(value).length !== METRIC_KEYS.size) add(errors, 'missing_metric_field')
        if (value.metricId !== expected.metricId) add(errors, 'noncanonical_metric_set')
        if (value.relation !== expected.relation) add(errors, 'invalid_metric_relation')
        if (value.owner !== expected.owner) add(errors, 'invalid_metric_owner')
        if (
            typeof value.status !== 'string' ||
            (!AVAILABLE_STATUSES.has(value.status as AnimationRumV3MetricStatus) &&
                !UNAVAILABLE_STATUSES.has(value.status as AnimationRumV3MetricStatus))
        ) {
            add(errors, 'invalid_metric_status')
            continue
        }
        const status = value.status as AnimationRumV3MetricStatus
        const available = AVAILABLE_STATUSES.has(status)
        const unavailable = UNAVAILABLE_STATUSES.has(status)
        const maximum = expected.unit === 'ratio' ? 100 : ANIMATION_RUM_V3_MAX_WINDOW_DURATION_MS
        if (value.value !== null && !finiteNumber(value.value, 0, maximum)) add(errors, 'invalid_metric_value')
        if (value.samples !== null && value.samples !== 1) add(errors, 'invalid_metric_samples')
        if (available && (value.value === null || value.samples !== 1)) add(errors, 'invalid_metric_null_semantics')
        if (unavailable && (value.value !== null || value.samples !== null)) add(errors, 'invalid_metric_null_semantics')
        if (available) availableMetricCount += 1
        if (capability) {
            const metricCapability = capability.metrics[expected.vitalName]
            const expectedUnavailable = expectedUnavailableStatus(metricCapability)
            if (expectedUnavailable !== null && status !== expectedUnavailable) add(errors, 'metric_capability_mismatch')
            if (expectedUnavailable === null && !available && status !== 'not-observed') add(errors, 'metric_capability_mismatch')
        }
        const qualityLoss = (qualityReasons?.length ?? 0) > 0
        if (status === 'measured' && qualityLoss) add(errors, 'metric_requires_partial_status')
        if (status === 'partial' && !qualityLoss) add(errors, 'partial_metric_without_limitation')
    }
    if (provider && provider.evidence !== availableMetricCount) add(errors, 'provider_metric_evidence_mismatch')
    return raw as AnimationRumV3Report['metrics']
}

function expectedCoverageStatus(metrics: AnimationRumV3Report['metrics']): AnimationRumV3MetricStatus {
    const statuses = metrics.map(metricValue => metricValue.status)
    if (statuses.includes('partial')) return 'partial'
    if (statuses.includes('measured')) return 'measured'
    if (statuses.includes('not-observed')) return 'not-observed'
    if (statuses.includes('unknown')) return 'unknown'
    if (statuses.includes('unsupported')) return 'unsupported'
    return 'not-instrumented'
}

export function validateNormalizedAnimationRumV3(raw: unknown, options: { nowEpochMs?: number } = {}): AnimationRumV3ValidationResult {
    const errors: string[] = []
    if (!isRecord(raw)) return { ok: false, errors: ['invalid_payload'] }
    if (payloadBytes(raw) > ANIMATION_RUM_V3_MAX_PAYLOAD_BYTES) add(errors, 'payload_too_large')
    rejectForbiddenKeys(raw, errors)
    rejectUnknownKeys(raw, ROOT_KEYS, errors, 'unknown_root_field')
    if (Object.keys(raw).length !== ROOT_KEYS.size) add(errors, 'missing_root_field')
    if (raw.contractVersion !== ANIMATION_RUM_V3_CONTRACT_VERSION) add(errors, 'unsupported_contract_version')
    if (raw.snapshotSchemaVersion !== ANIMATION_RUM_V3_SNAPSHOT_SCHEMA_VERSION) add(errors, 'unsupported_snapshot_schema_version')
    if (raw.captureKind !== ANIMATION_RUM_V3_CAPTURE_KIND) add(errors, 'invalid_capture_kind')
    if (!boundedString(raw.eventId, 80, ID_RE)) add(errors, 'invalid_event_id')
    if (!boundedString(raw.captureId, 80, ID_RE)) add(errors, 'invalid_capture_id')
    if (raw.scope !== 'page') add(errors, 'invalid_scope')
    if (raw.parentCaptureId !== null || raw.targetKey !== null) add(errors, 'invalid_page_scope_identity')
    const capturedTimestamp = canonicalUtcTimestamp(raw.capturedAt)
    const now = finiteNumber(options.nowEpochMs, 0, Number.MAX_SAFE_INTEGER) ? options.nowEpochMs : Date.now()
    if (capturedTimestamp === null) add(errors, 'invalid_captured_at')
    else if (capturedTimestamp < now - 90 * 24 * 60 * 60 * 1_000 || capturedTimestamp > now + 5 * 60 * 1_000) {
        add(errors, 'captured_at_out_of_range')
    }
    for (const [code, value] of [
        ['invalid_release', raw.release],
        ['invalid_dist', raw.dist],
        ['invalid_environment', raw.environment],
        ['invalid_sdk_version', raw.sdkVersion],
    ] as const) {
        if (!boundedString(value, 64, VERSION_RE, true)) add(errors, code)
    }
    if (!boundedString(raw.monitorVersion, 64, VERSION_RE)) add(errors, 'invalid_monitor_version')
    if (!finiteNumber(raw.sampleRate, 0.000001, 1)) add(errors, 'invalid_sample_rate')
    if (!boundedInteger(raw.samplingPolicyVersion, 255) || raw.samplingPolicyVersion < 1) add(errors, 'invalid_sampling_policy_version')

    const context = parseContext(raw.context, errors)
    const capability = parseCapabilities(raw.capabilities, errors)
    const provider = parseProviderEvidence(raw.providerEvidence, errors)
    const quality = parseCaptureQuality(raw.captureQuality, context, capability, provider, errors)
    const metrics = parseMetrics(raw.metrics, capability, provider, quality?.reasons ?? null, errors)

    if (!isRecord(raw.coverage)) add(errors, 'invalid_coverage')
    else {
        rejectUnknownKeys(raw.coverage, COVERAGE_KEYS, errors, 'unknown_coverage_family')
        if (Object.keys(raw.coverage).length !== 1 || !isRecord(raw.coverage.userOutcome)) add(errors, 'missing_coverage_family')
        else {
            const coverage = raw.coverage.userOutcome
            rejectUnknownKeys(coverage, COVERAGE_VALUE_KEYS, errors, 'unknown_coverage_field')
            if (Object.keys(coverage).length !== COVERAGE_VALUE_KEYS.size) add(errors, 'missing_coverage_field')
            if (
                typeof coverage.status !== 'string' ||
                (!AVAILABLE_STATUSES.has(coverage.status as AnimationRumV3MetricStatus) &&
                    !UNAVAILABLE_STATUSES.has(coverage.status as AnimationRumV3MetricStatus))
            ) {
                add(errors, 'invalid_coverage_status')
            } else if (metrics && coverage.status !== expectedCoverageStatus(metrics)) {
                add(errors, 'coverage_metric_status_mismatch')
            }
            const hasSupportedMetric = capability ? Object.values(capability.metrics).includes('supported') : false
            const expectedEvidence = hasSupportedMetric ? 'runtime-observation' : 'unsupported-or-unknown'
            if (coverage.evidenceLevel !== expectedEvidence) add(errors, 'invalid_coverage_evidence_semantics')
        }
    }

    if (quality && metrics) {
        const observed = metrics.some(metricValue => AVAILABLE_STATUSES.has(metricValue.status))
        if (quality.sufficiency !== (observed ? 'sufficient' : 'insufficient')) add(errors, 'invalid_capture_sufficiency_semantics')
    }

    if (errors.length > 0 || !context || !capability || !provider || !quality || !metrics) return { ok: false, errors }
    return { ok: true, value: raw as unknown as AnimationRumV3Report }
}
