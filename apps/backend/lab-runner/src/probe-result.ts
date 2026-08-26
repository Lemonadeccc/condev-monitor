import { ANIMATION_LAB_METRIC_CATALOG_V1, type AnimationLabMetric, type LabActionKind } from '@condev-monitor/animation-lab'

const MAX_ACTIONS = 100
const MAX_METRICS = 256
const MAX_ACTION_METRICS = 32
const MAX_SAMPLES = 10_000_000
const MAX_DURATION_MS = 60 * 60 * 1_000
const MAX_LIMITATION_INPUTS = 32
const MAX_SAFE_SCALAR = Number.MAX_SAFE_INTEGER
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/u

const ACTION_KINDS = new Set<LabActionKind>(['wait', 'click', 'hover', 'pointer-path', 'scroll', 'resize', 'drag', 'press'])
const METRIC_STATUSES = new Set(['measured', 'not-observed', 'unsupported'])
const ACTION_OUTCOMES = new Set(['completed', 'failed', 'cancelled'])
const CAPABILITY_KEYS = new Set([
    'longtask',
    'loaf',
    'eventTiming',
    'resourceTiming',
    'layoutShift',
    'lcp',
    'documentAnimations',
    'reducedMotion',
    'videoPlaybackQuality',
    'memory',
    'canvasContextObservation',
])
const PAGE_PROBE_LIMITATIONS = [
    'renderer-gpu-timing-requires-explicit-evidence',
    'continuous-input-observation-is-sampled',
    'canvas-context-observation-starts-at-probe-install',
] as const
const SAMPLE_DROP_KEYS = ['frames', 'longTasks', 'longAnimationFrames', 'eventTimings', 'resources'] as const
type SampleDropKey = (typeof SAMPLE_DROP_KEYS)[number]
type PageProbeSampleDrops = Record<SampleDropKey, number>
const SAMPLE_TRUNCATION_CONTRACT: Readonly<
    Record<
        SampleDropKey,
        {
            limitation: string
            capability?: string
            rootMetricIds: ReadonlySet<string>
            actionMetricIds: ReadonlySet<string>
        }
    >
> = {
    frames: {
        limitation: 'page-probe-frame-samples-truncated',
        rootMetricIds: new Set([
            'frame.duration.p50',
            'frame.duration.p95',
            'frame.duration.p99',
            'frame.refresh.inferred',
            'frame.slow-rate',
            'frame.jank-bursts',
            'frame.longest-slow-run',
            'frame.missed-opportunities',
        ]),
        actionMetricIds: new Set([
            'frame.duration.p50',
            'frame.duration.p95',
            'frame.duration.p99',
            'frame.slow-rate',
            'frame.jank-bursts',
        ]),
    },
    longTasks: {
        limitation: 'page-probe-long-task-samples-truncated',
        capability: 'longtask',
        rootMetricIds: new Set(['main.long-task.duration.p95']),
        actionMetricIds: new Set(['main.long-task.count', 'main.long-task.duration.p95']),
    },
    longAnimationFrames: {
        limitation: 'page-probe-loaf-samples-truncated',
        capability: 'loaf',
        rootMetricIds: new Set(['main.loaf.duration.p95', 'main.loaf.blocking.p95', 'pipeline.loaf-style-layout-tail.p95']),
        actionMetricIds: new Set(['main.loaf.count', 'main.loaf.duration.p95']),
    },
    eventTimings: {
        limitation: 'page-probe-event-timing-samples-truncated',
        capability: 'eventTiming',
        rootMetricIds: new Set([
            'interaction.event-duration.p95',
            'interaction.input-delay.p95',
            'interaction.processing.p95',
            'interaction.presentation.p95',
        ]),
        actionMetricIds: new Set([
            'interaction.event-duration.p95',
            'interaction.input-delay.p95',
            'interaction.processing.p95',
            'interaction.presentation.p95',
        ]),
    },
    resources: {
        limitation: 'page-probe-resource-timing-samples-truncated',
        capability: 'resourceTiming',
        rootMetricIds: new Set(['resource.duration.p95']),
        actionMetricIds: new Set(),
    },
}
const CAPABILITY_METRIC_IDS: Readonly<Record<string, readonly string[]>> = {
    longtask: ['main.long-task.count', 'main.long-task.duration.p95', 'main.long-task.duration.sum'],
    loaf: ['main.loaf.count', 'main.loaf.duration.p95', 'main.loaf.blocking.p95', 'pipeline.loaf-style-layout-tail.p95'],
    eventTiming: [
        'interaction.event-duration.p95',
        'interaction.input-delay.p95',
        'interaction.processing.p95',
        'interaction.presentation.p95',
        'interaction.count',
    ],
    resourceTiming: ['resource.count', 'resource.duration.p95', 'resource.transfer.sum', 'resource.encoded.sum', 'resource.decoded.sum'],
    layoutShift: ['vital.cls.latest'],
    lcp: ['vital.lcp.latest'],
    documentAnimations: ['animation.running.count', 'animation.infinite.count'],
    reducedMotion: ['accessibility.reduced-motion-active.count'],
    videoPlaybackQuality: ['media.video-dropped-frame-rate'],
    memory: ['memory.js-heap.latest'],
    canvasContextObservation: ['surface.canvas2d.count', 'surface.webgl.count', 'surface.webgpu.count'],
}

export const PAGE_PROBE_ROOT_METRIC_IDS = [
    'frame.duration.p50',
    'frame.duration.p95',
    'frame.duration.p99',
    'frame.target.latest',
    'frame.refresh.inferred',
    'frame.slow-rate',
    'frame.jank-bursts',
    'frame.longest-slow-run',
    'frame.missed-opportunities',
    'main.long-task.count',
    'main.long-task.duration.p95',
    'main.long-task.duration.sum',
    'main.loaf.count',
    'main.loaf.duration.p95',
    'main.loaf.blocking.p95',
    'pipeline.loaf-style-layout-tail.p95',
    'interaction.event-duration.p95',
    'interaction.input-delay.p95',
    'interaction.processing.p95',
    'interaction.presentation.p95',
    'interaction.count',
    'vital.cls.latest',
    'vital.lcp.latest',
    'resource.count',
    'resource.duration.p95',
    'resource.transfer.sum',
    'resource.encoded.sum',
    'resource.decoded.sum',
    'animation.running.count',
    'animation.infinite.count',
    'accessibility.reduced-motion-active.count',
    'surface.canvas.count',
    'surface.svg.count',
    'surface.canvas2d.count',
    'surface.webgl.count',
    'surface.webgpu.count',
    'surface.canvas-unknown.count',
    'surface.backing-pixels.sum',
    'media.video-elements.count',
    'media.video-dropped-frame-rate',
    'memory.js-heap.latest',
    'probe.dropped-samples.count',
    'probe.report-build.latest',
] as const

export const PAGE_PROBE_ACTION_METRIC_IDS = [
    'frame.duration.p50',
    'frame.duration.p95',
    'frame.duration.p99',
    'frame.slow-rate',
    'frame.jank-bursts',
    'main.long-task.count',
    'main.long-task.duration.p95',
    'main.loaf.count',
    'main.loaf.duration.p95',
    'interaction.event-duration.p95',
    'interaction.input-delay.p95',
    'interaction.processing.p95',
    'interaction.presentation.p95',
] as const

export const PAGE_PROBE_CAPABILITY_KEYS = [...CAPABILITY_KEYS] as const

type RecordValue = Record<string, unknown>
type ProbeMetricStatus = 'measured' | 'not-observed' | 'unsupported'
type ProbeActionOutcome = 'completed' | 'failed' | 'cancelled'

export interface ExpectedPageProbeAction {
    actionId: string
    order: number
    kind: LabActionKind
}

export interface DecodedPageProbeActionResult extends ExpectedPageProbeAction {
    startedAtMs: number
    endedAtMs: number
    outcome: ProbeActionOutcome
    metrics: AnimationLabMetric[]
}

export interface DecodedPageProbeResult {
    durationMs: number
    metrics: AnimationLabMetric[]
    actionResults: DecodedPageProbeActionResult[]
    capabilities: Record<string, boolean | null>
    limitations: string[]
}

function fail(label: string): never {
    throw new TypeError(`Invalid page probe result: ${label}`)
}

function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(label)
    return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    if (Object.keys(value).some(key => !allowedSet.has(key))) fail(`${label} contains unsupported fields`)
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
    if (!Array.isArray(value) || value.length > maximum) fail(label)
    return value
}

function token(value: unknown, label: string): string {
    if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) fail(label)
    return value
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(label)
    return Object.is(value, -0) ? 0 : value
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = finite(value, label, minimum, maximum)
    if (!Number.isSafeInteger(parsed)) fail(label)
    return parsed
}

function metricKey(family: string, name: string, stat: string, unit: string): string {
    return `${family}\u0000${name}\u0000${stat}\u0000${unit}`
}

const METRIC_CATALOG_BY_ID = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry] as const))

function producerMetricCatalog(metricIds: readonly string[]) {
    const catalog = new Map(
        metricIds.map(metricId => {
            const entry = METRIC_CATALOG_BY_ID.get(metricId)
            if (!entry) throw new Error(`Unknown page-probe metric contract: ${metricId}`)
            return [metricKey(entry.family, entry.name, entry.stat, entry.unit), entry] as const
        })
    )
    if (catalog.size !== metricIds.length) throw new Error('Page-probe metric contract contains an ambiguous producer tuple')
    return catalog
}

const ROOT_PAGE_PROBE_METRICS = producerMetricCatalog(PAGE_PROBE_ROOT_METRIC_IDS)
const ACTION_PAGE_PROBE_METRICS = producerMetricCatalog(PAGE_PROBE_ACTION_METRIC_IDS)

function metricMaximum(unit: AnimationLabMetric['unit']): number {
    switch (unit) {
        case 'ms':
            return MAX_DURATION_MS
        case 'ratio':
            return 1
        case 'percent':
            return 100
        case 'hz':
            return 1_000
        case 'score':
            // CLS is a score but is not capped at one like a Lighthouse category score.
            return 10_000
        case 'count':
        case 'frames':
            return MAX_SAMPLES
        case 'bytes':
        case 'pixels':
            return MAX_SAFE_SCALAR
    }
}

function metricValue(value: unknown, unit: AnimationLabMetric['unit'], label: string): number | null {
    if (value === null) return null
    const parsed = finite(value, label, 0, metricMaximum(unit))
    return ['count', 'frames', 'bytes', 'pixels'].includes(unit) ? integer(parsed, label, 0, metricMaximum(unit)) : parsed
}

function decodeMetrics(
    value: unknown,
    label: string,
    allowedMetrics: ReadonlyMap<string, (typeof ANIMATION_LAB_METRIC_CATALOG_V1)[number]>,
    maximum = MAX_METRICS
): AnimationLabMetric[] {
    const source = boundedArray(value, label, maximum)
    if (source.length !== allowedMetrics.size) fail(`${label} count`)
    const output: AnimationLabMetric[] = []
    const retainedTuples = new Set<string>()
    for (let index = 0; index < source.length; index += 1) {
        const metricLabel = `${label}[${index}]`
        const raw = record(source[index], metricLabel)
        exactKeys(raw, ['family', 'name', 'stat', 'unit', 'value', 'samples', 'status', 'evidenceLevel'], metricLabel)
        if (
            typeof raw.family !== 'string' ||
            typeof raw.name !== 'string' ||
            typeof raw.stat !== 'string' ||
            typeof raw.unit !== 'string'
        ) {
            fail(`${metricLabel} identity`)
        }
        const tuple = metricKey(raw.family, raw.name, raw.stat, raw.unit)
        const catalog = allowedMetrics.get(tuple)
        if (!catalog || retainedTuples.has(tuple)) fail(`${metricLabel} catalog identity`)
        retainedTuples.add(tuple)
        if (typeof raw.status !== 'string' || !METRIC_STATUSES.has(raw.status)) fail(`${metricLabel} status`)
        if (raw.evidenceLevel !== 'controlled-lab-measurement') fail(`${metricLabel} evidence level`)
        const status = raw.status as ProbeMetricStatus
        const parsedValue = metricValue(raw.value, catalog.unit, `${metricLabel} value`)
        if (status === 'measured' ? parsedValue === null : parsedValue !== null) fail(`${metricLabel} status/value relationship`)
        const samples = raw.samples === null ? null : integer(raw.samples, `${metricLabel} samples`, 0, MAX_SAMPLES)
        output.push({
            family: catalog.family,
            name: catalog.name,
            stat: catalog.stat,
            unit: catalog.unit,
            value: parsedValue,
            samples,
            status,
            evidenceLevel: 'controlled-lab-measurement',
        })
    }
    return output
}

function decodeCapabilities(value: unknown): Record<string, boolean | null> {
    const raw = record(value, 'capabilities')
    if (Object.keys(raw).length !== CAPABILITY_KEYS.size) fail('capabilities count')
    const output: Record<string, boolean | null> = {}
    for (const [key, item] of Object.entries(raw)) {
        if (!CAPABILITY_KEYS.has(key) || typeof item !== 'boolean') fail('capabilities')
        output[key] = item
    }
    return output
}

function decodeSampleDrops(value: unknown): PageProbeSampleDrops {
    const raw = record(value, 'sampleDrops')
    exactKeys(raw, SAMPLE_DROP_KEYS, 'sampleDrops')
    if (Object.keys(raw).length !== SAMPLE_DROP_KEYS.length) fail('sampleDrops count')
    return Object.fromEntries(
        SAMPLE_DROP_KEYS.map(key => [key, integer(raw[key], `sampleDrops.${key}`, 0, MAX_SAMPLES)])
    ) as PageProbeSampleDrops
}

function downgradeTruncatedMetrics(
    metrics: readonly AnimationLabMetric[],
    catalog: ReadonlyMap<string, (typeof ANIMATION_LAB_METRIC_CATALOG_V1)[number]>,
    sampleDrops: PageProbeSampleDrops,
    actionScoped: boolean
): AnimationLabMetric[] {
    return metrics.map(metric => {
        if (metric.status !== 'measured') return metric
        const entry = catalog.get(metricKey(metric.family, metric.name, metric.stat, metric.unit))
        if (!entry) fail('truncation metric identity')
        const limitations = SAMPLE_DROP_KEYS.flatMap(stream => {
            const contract = SAMPLE_TRUNCATION_CONTRACT[stream]
            const affected = actionScoped ? contract.actionMetricIds : contract.rootMetricIds
            return sampleDrops[stream] > 0 && affected.has(entry.metricId) ? [contract.limitation] : []
        })
        return limitations.length === 0
            ? metric
            : {
                  ...metric,
                  status: 'partial',
                  limitations: [...new Set([...(metric.limitations ?? []), ...limitations])],
              }
    })
}

function assertCapabilityMetricCoherence(
    capabilities: Readonly<Record<string, boolean | null>>,
    metrics: readonly AnimationLabMetric[],
    catalog: ReadonlyMap<string, (typeof ANIMATION_LAB_METRIC_CATALOG_V1)[number]>,
    label: string
): void {
    const statuses = new Map(
        metrics.map(metric => {
            const entry = catalog.get(metricKey(metric.family, metric.name, metric.stat, metric.unit))
            if (!entry) fail(`${label} identity`)
            return [entry.metricId, metric.status] as const
        })
    )
    for (const [capability, metricIds] of Object.entries(CAPABILITY_METRIC_IDS)) {
        const supported = capabilities[capability]
        for (const metricId of metricIds) {
            const status = statuses.get(metricId)
            if (status === undefined) continue
            if (supported === false && status !== 'unsupported') fail(`${label} capability coherence`)
            if (supported === true && status === 'unsupported') fail(`${label} capability coherence`)
        }
    }
}

function decodeExpectedActions(value: readonly ExpectedPageProbeAction[]): ExpectedPageProbeAction[] {
    if (!Array.isArray(value) || value.length > MAX_ACTIONS) fail('expected actions')
    const actionIds = new Set<string>()
    const orders = new Set<number>()
    return Array.from(value, (item, index) => {
        const raw = record(item, `expected actions[${index}]`)
        exactKeys(raw, ['actionId', 'order', 'kind'], `expected actions[${index}]`)
        const actionId = token(raw.actionId, `expected actions[${index}] actionId`)
        const order = integer(raw.order, `expected actions[${index}] order`, 0, MAX_ACTIONS - 1)
        if (typeof raw.kind !== 'string' || !ACTION_KINDS.has(raw.kind as LabActionKind)) fail(`expected actions[${index}] kind`)
        if (actionIds.has(actionId) || orders.has(order)) fail('expected actions uniqueness')
        actionIds.add(actionId)
        orders.add(order)
        return { actionId, order, kind: raw.kind as LabActionKind }
    })
}

function decodeActionResults(
    value: unknown,
    expectedActions: readonly ExpectedPageProbeAction[],
    durationMs: number
): DecodedPageProbeActionResult[] {
    const source = boundedArray(value, 'actionResults', MAX_ACTIONS)
    if (source.length !== expectedActions.length) fail('actionResults count')
    const expectedById = new Map(expectedActions.map(action => [action.actionId, action] as const))
    const decodedById = new Map<string, DecodedPageProbeActionResult>()
    for (let index = 0; index < source.length; index += 1) {
        const label = `actionResults[${index}]`
        const raw = record(source[index], label)
        exactKeys(raw, ['actionId', 'order', 'label', 'kind', 'startedAtMs', 'endedAtMs', 'outcome', 'metrics'], label)
        const actionId = token(raw.actionId, `${label} actionId`)
        const expected = expectedById.get(actionId)
        if (!expected || decodedById.has(actionId)) fail(`${label} identity`)
        const order = integer(raw.order, `${label} order`, 0, MAX_ACTIONS - 1)
        if (typeof raw.kind !== 'string' || raw.kind !== expected.kind || order !== expected.order) fail(`${label} scenario match`)
        // Browser-probe currently returns its configured label. Validate its safe shape, but never retain it.
        token(raw.label, `${label} label`)
        const startedAtMs = finite(raw.startedAtMs, `${label} start`, 0, MAX_DURATION_MS)
        const endedAtMs = finite(raw.endedAtMs, `${label} end`, startedAtMs, MAX_DURATION_MS)
        if (endedAtMs > durationMs) fail(`${label} clock bounds`)
        if (typeof raw.outcome !== 'string' || !ACTION_OUTCOMES.has(raw.outcome)) fail(`${label} outcome`)
        decodedById.set(actionId, {
            actionId: expected.actionId,
            order: expected.order,
            kind: expected.kind,
            startedAtMs,
            endedAtMs,
            outcome: raw.outcome as ProbeActionOutcome,
            metrics: decodeMetrics(raw.metrics, `${label}.metrics`, ACTION_PAGE_PROBE_METRICS, MAX_ACTION_METRICS),
        })
    }
    return expectedActions.map(action => decodedById.get(action.actionId) ?? fail('actionResults one-to-one mapping'))
}

/**
 * Decodes the untrusted structured-clone returned by the disposable page probe.
 * Every returned object is rebuilt from closed runner/shared contracts.
 */
export function decodePageProbeResult(rawValue: unknown, expectedActionsValue: readonly ExpectedPageProbeAction[]): DecodedPageProbeResult {
    const raw = record(rawValue, 'root')
    exactKeys(raw, ['durationMs', 'metrics', 'actionResults', 'capabilities', 'sampleDrops', 'limitations'], 'root')
    const durationMs = finite(raw.durationMs, 'duration', 0, MAX_DURATION_MS)
    const expectedActions = decodeExpectedActions(expectedActionsValue)
    const rawMetrics = decodeMetrics(raw.metrics, 'metrics', ROOT_PAGE_PROBE_METRICS)
    const capabilities = decodeCapabilities(raw.capabilities)
    const sampleDrops = decodeSampleDrops(raw.sampleDrops)
    // Page prose is intentionally ignored. Only its bounded container shape is accepted.
    const ignoredLimitations = boundedArray(raw.limitations, 'limitations', MAX_LIMITATION_INPUTS)
    if (ignoredLimitations.some(item => typeof item !== 'string' || item.length > 200)) fail('limitations')
    const droppedSamples = rawMetrics.find(metric => metric.family === 'monitorOverhead' && metric.name === 'droppedProbeSamples')?.value
    if (droppedSamples !== SAMPLE_DROP_KEYS.reduce((total, key) => total + sampleDrops[key], 0)) fail('sampleDrops total coherence')
    for (const stream of SAMPLE_DROP_KEYS) {
        const capability = SAMPLE_TRUNCATION_CONTRACT[stream].capability
        if (sampleDrops[stream] > 0 && capability && capabilities[capability] !== true) fail('sampleDrops capability coherence')
    }
    const metrics = downgradeTruncatedMetrics(rawMetrics, ROOT_PAGE_PROBE_METRICS, sampleDrops, false)
    const actionResults = decodeActionResults(raw.actionResults, expectedActions, durationMs).map(action => ({
        ...action,
        metrics: downgradeTruncatedMetrics(action.metrics, ACTION_PAGE_PROBE_METRICS, sampleDrops, true),
    }))
    assertCapabilityMetricCoherence(capabilities, metrics, ROOT_PAGE_PROBE_METRICS, 'metrics')
    for (const action of actionResults) {
        assertCapabilityMetricCoherence(capabilities, action.metrics, ACTION_PAGE_PROBE_METRICS, `actionResults[${action.order}].metrics`)
    }
    return {
        durationMs,
        metrics,
        actionResults,
        capabilities,
        limitations: [
            ...PAGE_PROBE_LIMITATIONS,
            ...(typeof droppedSamples === 'number' && droppedSamples > 0 ? ['page-probe-samples-truncated'] : []),
        ],
    }
}
