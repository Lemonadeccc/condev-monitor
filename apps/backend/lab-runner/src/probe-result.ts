import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V2,
    type AnimationLabMetric,
    type LabActionKind,
    type LabMetricCatalogEntryV1,
    type LabMetricCatalogVersion,
} from '@condev-monitor/animation-lab'

const MAX_ACTIONS = 100
const MAX_METRICS = 256
const MAX_ACTION_METRICS = 32
const MAX_SAMPLES = 10_000_000
const MAX_DURATION_MS = 60 * 60 * 1_000
const MAX_LIMITATION_INPUTS = 32
const MAX_SAFE_SCALAR = Number.MAX_SAFE_INTEGER
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/u

const ACTION_KINDS = new Set<LabActionKind>(['wait', 'click', 'hover', 'pointer-path', 'scroll', 'resize', 'drag', 'press'])
const METRIC_STATUSES = new Set(['measured', 'not-observed', 'unsupported', 'unknown'])
const ACTION_OUTCOMES = new Set(['completed', 'failed', 'cancelled'])
const CAPABILITY_KEYS_V1 = new Set([
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
const CAPABILITY_KEYS_V2 = new Set([
    ...CAPABILITY_KEYS_V1,
    'loafPaintTime',
    'loafPresentationTime',
    'inputFrameScheduling',
    'loafFirstUIEventTimestamp',
    'loafForcedStyleAndLayoutDuration',
])
const PAGE_PROBE_LIMITATIONS = [
    'renderer-gpu-timing-requires-explicit-evidence',
    'continuous-input-observation-is-sampled',
    'canvas-context-observation-starts-at-probe-install',
] as const
const SAMPLE_DROP_KEYS_V1 = ['frames', 'longTasks', 'longAnimationFrames', 'eventTimings', 'resources'] as const
const SAMPLE_DROP_KEYS_V2 = [...SAMPLE_DROP_KEYS_V1, 'inputFrameScheduling'] as const
type SampleDropKey = (typeof SAMPLE_DROP_KEYS_V2)[number]
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
        rootMetricIds: new Set([
            'main.loaf.duration.p95',
            'main.loaf.blocking.p95',
            'pipeline.loaf-style-layout-tail.p95',
            'pipeline.loaf-render-start-to-paint.p95',
            'pipeline.loaf-paint-to-presentation.p95',
            'interaction.loaf-first-ui-event-to-frame-end.p95',
            'pipeline.loaf-attributed-forced-style-layout.p95',
        ]),
        actionMetricIds: new Set([
            'main.loaf.count',
            'main.loaf.duration.p95',
            'pipeline.loaf-render-start-to-paint.count',
            'pipeline.loaf-render-start-to-paint.p95',
            'pipeline.loaf-paint-to-presentation.count',
            'pipeline.loaf-paint-to-presentation.p95',
            'interaction.loaf-first-ui-event-to-frame-end.count',
            'interaction.loaf-first-ui-event-to-frame-end.p95',
            'pipeline.loaf-attributed-forced-style-layout.count',
            'pipeline.loaf-attributed-forced-style-layout.p95',
        ]),
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
    inputFrameScheduling: {
        limitation: 'page-probe-input-frame-scheduling-samples-truncated',
        capability: 'inputFrameScheduling',
        rootMetricIds: new Set(['main.input-capture-to-next-raf-callback.p95']),
        actionMetricIds: new Set(['main.input-capture-to-next-raf-callback.p95']),
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
    loafPaintTime: ['pipeline.loaf-render-start-to-paint.count', 'pipeline.loaf-render-start-to-paint.p95'],
    inputFrameScheduling: ['main.input-capture-to-next-raf-callback.count', 'main.input-capture-to-next-raf-callback.p95'],
    loafFirstUIEventTimestamp: ['interaction.loaf-first-ui-event-to-frame-end.count', 'interaction.loaf-first-ui-event-to-frame-end.p95'],
    loafForcedStyleAndLayoutDuration: [
        'pipeline.loaf-attributed-forced-style-layout.count',
        'pipeline.loaf-attributed-forced-style-layout.p95',
    ],
}
const PHASE_PAIR_CONTRACTS = [
    {
        countMetricId: 'pipeline.loaf-render-start-to-paint.count',
        percentileMetricId: 'pipeline.loaf-render-start-to-paint.p95',
        dropStream: 'longAnimationFrames',
        incompleteLimitation: 'loaf-render-paint-boundary-candidates-incomplete',
    },
    {
        countMetricId: 'pipeline.loaf-paint-to-presentation.count',
        percentileMetricId: 'pipeline.loaf-paint-to-presentation.p95',
        dropStream: 'longAnimationFrames',
        incompleteLimitation: 'loaf-paint-presentation-boundary-candidates-incomplete',
    },
    {
        countMetricId: 'main.input-capture-to-next-raf-callback.count',
        percentileMetricId: 'main.input-capture-to-next-raf-callback.p95',
        dropStream: 'inputFrameScheduling',
        incompleteLimitation: 'input-frame-scheduling-candidates-incomplete',
    },
    {
        countMetricId: 'interaction.loaf-first-ui-event-to-frame-end.count',
        percentileMetricId: 'interaction.loaf-first-ui-event-to-frame-end.p95',
        dropStream: 'longAnimationFrames',
        incompleteLimitation: 'loaf-first-ui-event-candidates-incomplete',
    },
    {
        countMetricId: 'pipeline.loaf-attributed-forced-style-layout.count',
        percentileMetricId: 'pipeline.loaf-attributed-forced-style-layout.p95',
        dropStream: 'longAnimationFrames',
        incompleteLimitation: 'loaf-forced-style-layout-attribution-incomplete',
    },
] as const
type PhasePairMetricId = (typeof PHASE_PAIR_CONTRACTS)[number]['countMetricId']

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

export const PAGE_PROBE_ROOT_METRIC_IDS_V2 = [
    ...PAGE_PROBE_ROOT_METRIC_IDS,
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

export const PAGE_PROBE_ACTION_METRIC_IDS_V2 = [
    ...PAGE_PROBE_ACTION_METRIC_IDS,
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
] as const

export const PAGE_PROBE_CAPABILITY_KEYS = [...CAPABILITY_KEYS_V1] as const
export const PAGE_PROBE_CAPABILITY_KEYS_V2 = [...CAPABILITY_KEYS_V2] as const

type RecordValue = Record<string, unknown>
type ProbeMetricStatus = 'measured' | 'not-observed' | 'unsupported' | 'unknown'
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

const METRIC_CATALOG_BY_ID_V1 = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry] as const))
const METRIC_CATALOG_BY_ID_V2 = new Map(ANIMATION_LAB_METRIC_CATALOG_V2.map(entry => [entry.metricId, entry] as const))

function producerMetricCatalog(metricIds: readonly string[], metricCatalog: ReadonlyMap<string, LabMetricCatalogEntryV1>) {
    const catalog = new Map(
        metricIds.map(metricId => {
            const entry = metricCatalog.get(metricId)
            if (!entry) throw new Error(`Unknown page-probe metric contract: ${metricId}`)
            return [metricKey(entry.family, entry.name, entry.stat, entry.unit), entry] as const
        })
    )
    if (catalog.size !== metricIds.length) throw new Error('Page-probe metric contract contains an ambiguous producer tuple')
    return catalog
}

const ROOT_PAGE_PROBE_METRICS_V1 = producerMetricCatalog(PAGE_PROBE_ROOT_METRIC_IDS, METRIC_CATALOG_BY_ID_V1)
const ACTION_PAGE_PROBE_METRICS_V1 = producerMetricCatalog(PAGE_PROBE_ACTION_METRIC_IDS, METRIC_CATALOG_BY_ID_V1)
const ROOT_PAGE_PROBE_METRICS_V2 = producerMetricCatalog(PAGE_PROBE_ROOT_METRIC_IDS_V2, METRIC_CATALOG_BY_ID_V2)
const ACTION_PAGE_PROBE_METRICS_V2 = producerMetricCatalog(PAGE_PROBE_ACTION_METRIC_IDS_V2, METRIC_CATALOG_BY_ID_V2)

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

function metricLimitations(metricId: string): string[] {
    if (metricId === 'frame.refresh.inferred') return ['observed-page-raf-cadence-not-display-refresh-rate']
    if (metricId.startsWith('pipeline.loaf-render-start-to-paint')) return ['loaf-only-over-50ms']
    if (metricId.startsWith('pipeline.loaf-paint-to-presentation')) {
        return ['loaf-only-over-50ms', 'presentation-time-implementation-dependent']
    }
    if (metricId.startsWith('main.input-capture-to-next-raf-callback')) {
        return ['input-capture-listener-to-next-raf-callback-proxy', 'not-paint-or-presentation-timing', 'trusted-discrete-input-only']
    }
    if (metricId.startsWith('interaction.loaf-first-ui-event-to-frame-end')) {
        return ['loaf-only-over-50ms', 'loaf-frame-end-not-paint-or-presentation', 'first-ui-event-may-predate-loaf']
    }
    if (metricId.startsWith('pipeline.loaf-attributed-forced-style-layout')) {
        return ['loaf-only-over-50ms', 'loaf-attributed-scripts-lower-bound', 'forced-style-layout-implementation-dependent']
    }
    return []
}

function decodeMetrics(
    value: unknown,
    label: string,
    allowedMetrics: ReadonlyMap<string, LabMetricCatalogEntryV1>,
    metricCatalogVersion: LabMetricCatalogVersion,
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
        const status = raw.status as ProbeMetricStatus
        if (status === 'unknown' && metricCatalogVersion !== 2) fail(`${metricLabel} status`)
        const expectedProducerEvidenceLevel =
            metricCatalogVersion === 2 && (status === 'unsupported' || status === 'unknown')
                ? 'unsupported-or-unknown'
                : 'controlled-lab-measurement'
        if (raw.evidenceLevel !== expectedProducerEvidenceLevel) fail(`${metricLabel} evidence level`)
        const parsedValue = metricValue(raw.value, catalog.unit, `${metricLabel} value`)
        if (status === 'measured' ? parsedValue === null : parsedValue !== null) fail(`${metricLabel} status/value relationship`)
        const samples = raw.samples === null ? null : integer(raw.samples, `${metricLabel} samples`, 0, MAX_SAMPLES)
        const limitations = metricLimitations(catalog.metricId)
        output.push({
            family: catalog.family,
            name: catalog.name,
            stat: catalog.stat,
            unit: catalog.unit,
            value: parsedValue,
            samples,
            status,
            // Preserve the exact v1 producer wire contract while rebuilding a
            // semantically consistent expanded metric for reports.
            evidenceLevel: status === 'unsupported' || status === 'unknown' ? 'unsupported-or-unknown' : expectedProducerEvidenceLevel,
            ...(limitations.length > 0 ? { limitations } : {}),
        })
    }
    return output
}

function decodeCapabilities(value: unknown, metricCatalogVersion: LabMetricCatalogVersion): Record<string, boolean | null> {
    const raw = record(value, 'capabilities')
    const capabilityKeys = metricCatalogVersion === 2 ? CAPABILITY_KEYS_V2 : CAPABILITY_KEYS_V1
    if (Object.keys(raw).length !== capabilityKeys.size) fail('capabilities count')
    const output: Record<string, boolean | null> = {}
    for (const [key, item] of Object.entries(raw)) {
        const nullable =
            metricCatalogVersion === 2 &&
            (key === 'loafPaintTime' ||
                key === 'loafPresentationTime' ||
                key === 'loafFirstUIEventTimestamp' ||
                key === 'loafForcedStyleAndLayoutDuration')
        if (!capabilityKeys.has(key) || (typeof item !== 'boolean' && !(nullable && item === null))) fail('capabilities')
        output[key] = item
    }
    if (metricCatalogVersion === 2) {
        const loafFieldCapabilities = [
            output.loafPaintTime,
            output.loafPresentationTime,
            output.loafFirstUIEventTimestamp,
            output.loafForcedStyleAndLayoutDuration,
        ]
        if (output.loaf === false && loafFieldCapabilities.some(capability => capability !== false)) {
            fail('LoAF field capability coherence')
        }
        if (loafFieldCapabilities.some(capability => capability === true) && output.loaf !== true) {
            fail('LoAF field capability coherence')
        }
    }
    return output
}

function decodeSampleDrops(value: unknown, metricCatalogVersion: LabMetricCatalogVersion): PageProbeSampleDrops {
    const raw = record(value, 'sampleDrops')
    const keys = metricCatalogVersion === 2 ? SAMPLE_DROP_KEYS_V2 : SAMPLE_DROP_KEYS_V1
    exactKeys(raw, keys, 'sampleDrops')
    if (Object.keys(raw).length !== keys.length) fail('sampleDrops count')
    const decoded = Object.fromEntries(
        keys.map(key => [key, integer(raw[key], `sampleDrops.${key}`, 0, MAX_SAMPLES)])
    ) as Partial<PageProbeSampleDrops>
    return { ...decoded, inputFrameScheduling: decoded.inputFrameScheduling ?? 0 } as PageProbeSampleDrops
}

function downgradeTruncatedMetrics(
    metrics: readonly AnimationLabMetric[],
    catalog: ReadonlyMap<string, LabMetricCatalogEntryV1>,
    sampleDrops: PageProbeSampleDrops,
    actionScoped: boolean
): AnimationLabMetric[] {
    return metrics.map(metric => {
        const entry = catalog.get(metricKey(metric.family, metric.name, metric.stat, metric.unit))
        if (!entry) fail('truncation metric identity')
        const limitations = SAMPLE_DROP_KEYS_V2.flatMap(stream => {
            const contract = SAMPLE_TRUNCATION_CONTRACT[stream]
            const affected = actionScoped ? contract.actionMetricIds : contract.rootMetricIds
            return sampleDrops[stream] > 0 && affected.has(entry.metricId) ? [contract.limitation] : []
        })
        if (limitations.length === 0) return metric
        return {
            ...metric,
            ...(metric.status === 'measured' ? { status: 'partial' as const } : {}),
            limitations: [...new Set([...(metric.limitations ?? []), ...limitations])],
        }
    })
}

function addMetricLimitation(metric: AnimationLabMetric, limitation: string, derivePartial: boolean): AnimationLabMetric {
    return {
        ...metric,
        ...(derivePartial && metric.status === 'measured' ? { status: 'partial' as const } : {}),
        limitations: [...new Set([...(metric.limitations ?? []), limitation])],
    }
}

function enforcePhasePairContracts(
    metrics: readonly AnimationLabMetric[],
    catalog: ReadonlyMap<string, LabMetricCatalogEntryV1>,
    sampleDrops: PageProbeSampleDrops,
    globallyIncompletePairs: ReadonlySet<PhasePairMetricId> = new Set()
): { metrics: AnimationLabMetric[]; incompletePairs: Set<PhasePairMetricId> } {
    const metricIndexById = new Map<string, number>()
    metrics.forEach((metric, index) => {
        const entry = catalog.get(metricKey(metric.family, metric.name, metric.stat, metric.unit))
        if (!entry) fail('phase pair metric identity')
        metricIndexById.set(entry.metricId, index)
    })
    const output = [...metrics]
    const incompletePairs = new Set<PhasePairMetricId>()
    for (const contract of PHASE_PAIR_CONTRACTS) {
        const countIndex = metricIndexById.get(contract.countMetricId)
        const percentileIndex = metricIndexById.get(contract.percentileMetricId)
        if (countIndex === undefined && percentileIndex === undefined) continue
        if (countIndex === undefined || percentileIndex === undefined) fail('phase pair completeness')
        const countMetric = output[countIndex]
        const percentileMetric = output[percentileIndex]
        if (!countMetric || !percentileMetric) fail('phase pair completeness')
        if (countMetric.status === 'unsupported' || countMetric.status === 'unknown') {
            if (
                percentileMetric.status !== countMetric.status ||
                countMetric.value !== null ||
                countMetric.samples !== null ||
                percentileMetric.value !== null ||
                percentileMetric.samples !== null
            ) {
                fail('phase pair unavailable contract')
            }
            continue
        }
        if (
            countMetric.status !== 'measured' ||
            countMetric.value === null ||
            countMetric.samples === null ||
            !Number.isSafeInteger(countMetric.value) ||
            countMetric.value > countMetric.samples
        ) {
            fail('phase pair count contract')
        }
        if (
            (percentileMetric.status !== 'measured' && percentileMetric.status !== 'not-observed') ||
            percentileMetric.samples === null ||
            !Number.isSafeInteger(percentileMetric.samples) ||
            percentileMetric.samples > countMetric.value
        ) {
            fail('phase pair percentile contract')
        }
        if (percentileMetric.status === 'measured') {
            if (percentileMetric.value === null || percentileMetric.samples === 0) fail('phase pair measured percentile contract')
        } else if (percentileMetric.value !== null || percentileMetric.samples !== 0) {
            fail('phase pair not-observed percentile contract')
        }
        if (percentileMetric.samples < countMetric.value && sampleDrops[contract.dropStream] === 0) {
            fail('phase pair retained-sample coherence')
        }
        const incomplete = countMetric.value < countMetric.samples || globallyIncompletePairs.has(contract.countMetricId)
        if (!incomplete) continue
        incompletePairs.add(contract.countMetricId)
        output[countIndex] = addMetricLimitation(countMetric, contract.incompleteLimitation, false)
        output[percentileIndex] = addMetricLimitation(percentileMetric, contract.incompleteLimitation, true)
    }
    return { metrics: output, incompletePairs }
}

function assertCapabilityMetricCoherence(
    capabilities: Readonly<Record<string, boolean | null>>,
    metrics: readonly AnimationLabMetric[],
    catalog: ReadonlyMap<string, LabMetricCatalogEntryV1>,
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
            if (supported === true && (status === 'unsupported' || status === 'unknown')) fail(`${label} capability coherence`)
            if (supported === null && status !== 'unknown') fail(`${label} capability coherence`)
        }
    }
    const paintToPresentationStatus =
        capabilities.loafPaintTime === false || capabilities.loafPresentationTime === false
            ? false
            : capabilities.loafPaintTime === null || capabilities.loafPresentationTime === null
              ? null
              : capabilities.loafPaintTime === true && capabilities.loafPresentationTime === true
                ? true
                : undefined
    for (const metricId of ['pipeline.loaf-paint-to-presentation.count', 'pipeline.loaf-paint-to-presentation.p95']) {
        const status = statuses.get(metricId)
        if (status === undefined) continue
        if (paintToPresentationStatus === false && status !== 'unsupported') fail(`${label} capability coherence`)
        if (paintToPresentationStatus === true && (status === 'unsupported' || status === 'unknown')) {
            fail(`${label} capability coherence`)
        }
        if (paintToPresentationStatus === null && status !== 'unknown') fail(`${label} capability coherence`)
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
    durationMs: number,
    metricCatalogVersion: LabMetricCatalogVersion,
    actionMetricCatalog: ReadonlyMap<string, LabMetricCatalogEntryV1>
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
            metrics: decodeMetrics(raw.metrics, `${label}.metrics`, actionMetricCatalog, metricCatalogVersion, MAX_ACTION_METRICS),
        })
    }
    return expectedActions.map(action => decodedById.get(action.actionId) ?? fail('actionResults one-to-one mapping'))
}

/**
 * Decodes the untrusted structured-clone returned by the disposable page probe.
 * Every returned object is rebuilt from closed runner/shared contracts.
 */
export function decodePageProbeResult(
    rawValue: unknown,
    expectedActionsValue: readonly ExpectedPageProbeAction[],
    metricCatalogVersion: LabMetricCatalogVersion = 1
): DecodedPageProbeResult {
    if (metricCatalogVersion !== 1 && metricCatalogVersion !== 2) fail('metric catalog version')
    const raw = record(rawValue, 'root')
    exactKeys(raw, ['durationMs', 'metrics', 'actionResults', 'capabilities', 'sampleDrops', 'limitations'], 'root')
    const durationMs = finite(raw.durationMs, 'duration', 0, MAX_DURATION_MS)
    const expectedActions = decodeExpectedActions(expectedActionsValue)
    const rootMetricCatalog = metricCatalogVersion === 2 ? ROOT_PAGE_PROBE_METRICS_V2 : ROOT_PAGE_PROBE_METRICS_V1
    const actionMetricCatalog = metricCatalogVersion === 2 ? ACTION_PAGE_PROBE_METRICS_V2 : ACTION_PAGE_PROBE_METRICS_V1
    const rawMetrics = decodeMetrics(raw.metrics, 'metrics', rootMetricCatalog, metricCatalogVersion)
    const capabilities = decodeCapabilities(raw.capabilities, metricCatalogVersion)
    const sampleDrops = decodeSampleDrops(raw.sampleDrops, metricCatalogVersion)
    // Page prose is intentionally ignored. Only its bounded container shape is accepted.
    const ignoredLimitations = boundedArray(raw.limitations, 'limitations', MAX_LIMITATION_INPUTS)
    if (ignoredLimitations.some(item => typeof item !== 'string' || item.length > 200)) fail('limitations')
    const droppedSamples = rawMetrics.find(metric => metric.family === 'monitorOverhead' && metric.name === 'droppedProbeSamples')?.value
    const activeSampleDropKeys = metricCatalogVersion === 2 ? SAMPLE_DROP_KEYS_V2 : SAMPLE_DROP_KEYS_V1
    if (droppedSamples !== activeSampleDropKeys.reduce((total, key) => total + sampleDrops[key], 0)) {
        fail('sampleDrops total coherence')
    }
    for (const stream of activeSampleDropKeys) {
        const capability = SAMPLE_TRUNCATION_CONTRACT[stream].capability
        if (sampleDrops[stream] > 0 && capability && capabilities[capability] !== true) fail('sampleDrops capability coherence')
    }
    const rootPairs =
        metricCatalogVersion === 2
            ? enforcePhasePairContracts(rawMetrics, rootMetricCatalog, sampleDrops)
            : { metrics: rawMetrics, incompletePairs: new Set<PhasePairMetricId>() }
    const metrics = downgradeTruncatedMetrics(rootPairs.metrics, rootMetricCatalog, sampleDrops, false)
    const actionResults = decodeActionResults(
        raw.actionResults,
        expectedActions,
        durationMs,
        metricCatalogVersion,
        actionMetricCatalog
    ).map(action => {
        const actionPairs =
            metricCatalogVersion === 2
                ? enforcePhasePairContracts(action.metrics, actionMetricCatalog, sampleDrops, rootPairs.incompletePairs)
                : { metrics: action.metrics }
        return {
            ...action,
            metrics: downgradeTruncatedMetrics(actionPairs.metrics, actionMetricCatalog, sampleDrops, true),
        }
    })
    assertCapabilityMetricCoherence(capabilities, metrics, rootMetricCatalog, 'metrics')
    for (const action of actionResults) {
        assertCapabilityMetricCoherence(capabilities, action.metrics, actionMetricCatalog, `actionResults[${action.order}].metrics`)
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
