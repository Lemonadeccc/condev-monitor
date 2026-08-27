import {
    ANIMATION_RUM_FAMILIES,
    ANIMATION_RUM_V2_CAPABILITIES,
    type AnimationRumV2MetricBinding,
    type AnimationRumV2MetricDefinition,
    type AnimationRumV2ProviderEvidence,
    type AnimationRumV2Report,
} from '../v2'

// cspell:ignore noncanonical

export const ANIMATION_RUM_V2_GOLDEN_NOW = Date.parse('2026-08-27T08:00:00.000Z')

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

export function createAnimationRumV2GoldenReport(): AnimationRumV2Report {
    return {
        contractVersion: 2,
        snapshotSchemaVersion: 1,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        scope: 'page',
        parentCaptureId: null,
        targetKey: null,
        capturedAt: '2026-08-27T07:59:00.000Z',
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '0.1.0',
        monitorVersion: '0.1.0',
        sampleRate: 0.1,
        samplingPolicyVersion: 2,
        context: {
            routeKey: 'product-detail',
            visibilityState: 'visible',
            reducedMotion: false,
            viewportBucket: 'large',
            dprBucket: '2',
            refreshHz: 60,
            refreshBudgetSource: 'explicit',
            refreshBudgetConfidence: 'explicit',
            windowDurationMs: 10_000,
            windowDurationCapped: false,
            runtime: { framework: 'react', renderer: 'dom', backend: 'dom' },
        },
        capabilities: Object.fromEntries(
            ANIMATION_RUM_V2_CAPABILITIES.map(name => [name, 'unknown'])
        ) as AnimationRumV2Report['capabilities'],
        coverage: Object.fromEntries(
            ANIMATION_RUM_FAMILIES.map(family => [
                family,
                family === 'frameCadence'
                    ? { status: 'measured', evidenceLevel: 'runtime-observation' }
                    : { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' },
            ])
        ) as AnimationRumV2Report['coverage'],
        captureQuality: {
            sufficiency: 'sufficient',
            integrity: 'complete',
            reasons: [],
            adapterErrorCount: 0,
        },
        providerEvidence: {
            'browser-core': {
                frameCadence: {
                    version: '0.1.0',
                    accepted: 120,
                    retained: 120,
                    evidence: 120,
                    dropped: 0,
                    rejected: 0,
                    truncated: false,
                },
            },
        },
        metrics: [
            {
                metricId: 'frame.duration.p95',
                relation: 'page-window',
                owner: 'browser-core',
                value: 18.5,
                samples: 120,
                status: 'measured',
            },
        ],
    }
}

function provider(version = '0.1.0'): AnimationRumV2ProviderEvidence {
    return {
        version,
        accepted: 3,
        retained: 3,
        evidence: 3,
        dropped: 0,
        rejected: 0,
        truncated: false,
    }
}

export function createAnimationRumV2ReportForMetric(
    definition: AnimationRumV2MetricDefinition,
    binding: AnimationRumV2MetricBinding
): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.scope = binding.scope
    report.parentCaptureId = binding.scope === 'target' ? 'capture_parent_1234' : null
    report.targetKey = binding.scope === 'target' ? 'hero-canvas' : null
    const owner = binding.owners[0]!
    report.providerEvidence = { [owner]: { [definition.family]: provider() } }
    report.metrics = [
        {
            metricId: definition.metricId,
            relation: binding.relation,
            owner,
            value: definition.allowedValues?.[0] ?? (definition.unit === 'ratio' ? 0.25 : definition.unit === 'score' ? 0.1 : 1),
            samples: 3,
            status: 'measured',
        },
    ]
    report.coverage = Object.fromEntries(
        ANIMATION_RUM_FAMILIES.map(family => [
            family,
            family === definition.family
                ? { status: 'measured', evidenceLevel: 'runtime-observation' }
                : { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' },
        ])
    ) as AnimationRumV2Report['coverage']
    for (const capability of definition.requiredCapabilities) report.capabilities[capability] = 'supported'
    return report
}

function validTargetDirect(): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.scope = 'target'
    report.parentCaptureId = 'capture_parent_1234'
    report.targetKey = 'hero-canvas'
    report.capabilities['document-animations-inspection'] = 'supported'
    report.providerEvidence = { 'target-sidecar': { motionQuality: provider() } }
    report.metrics = [
        {
            metricId: 'animation.running.count',
            relation: 'target-direct',
            owner: 'target-sidecar',
            value: 2,
            samples: 3,
            status: 'measured',
        },
    ]
    report.coverage.motionQuality = { status: 'measured', evidenceLevel: 'runtime-observation' }
    report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    return report
}

function validTargetTemporalPartial(): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.scope = 'target'
    report.parentCaptureId = 'capture_parent_1234'
    report.targetKey = 'hero-canvas'
    report.providerEvidence['browser-core']!.frameCadence = {
        version: '0.1.0',
        accepted: 120,
        retained: 100,
        evidence: 100,
        dropped: 20,
        rejected: 0,
        truncated: true,
    }
    report.captureQuality = {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['provider-truncated'],
        adapterErrorCount: 0,
    }
    report.metrics[0] = {
        ...report.metrics[0]!,
        relation: 'target-temporal-overlap',
        samples: 100,
        status: 'partial',
    }
    report.coverage.frameCadence = { status: 'partial', evidenceLevel: 'runtime-observation' }
    return report
}

function validWindowCappedFramePartial(): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.context.windowDurationMs = 604_800_000
    report.context.windowDurationCapped = true
    report.captureQuality = {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['window-capped'],
        adapterErrorCount: 0,
    }
    report.metrics[0]!.status = 'partial'
    report.coverage.frameCadence = { status: 'partial', evidenceLevel: 'runtime-observation' }
    return report
}

function validWindowCappedDocumentLifetime(): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.context.windowDurationMs = 604_800_000
    report.context.windowDurationCapped = true
    report.captureQuality = {
        sufficiency: 'sufficient',
        integrity: 'partial',
        reasons: ['window-capped'],
        adapterErrorCount: 0,
    }
    report.capabilities['web-vitals'] = 'supported'
    report.providerEvidence = { 'web-vitals-runtime': { userOutcome: provider() } }
    report.metrics = [
        {
            metricId: 'vital.lcp.latest',
            relation: 'page-window',
            owner: 'web-vitals-runtime',
            value: 1_500,
            samples: 1,
            status: 'measured',
        },
    ]
    report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    report.coverage.userOutcome = { status: 'measured', evidenceLevel: 'runtime-observation' }
    return report
}

function longTaskReport(): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.capabilities.longtask = 'supported'
    report.providerEvidence = { 'browser-core': { mainThread: provider() } }
    report.metrics = [
        {
            metricId: 'main.long-task.count',
            relation: 'page-window',
            owner: 'browser-core',
            value: 3,
            samples: 3,
            status: 'measured',
        },
        {
            metricId: 'main.long-task-duration.p95',
            relation: 'page-window',
            owner: 'browser-core',
            value: 80,
            samples: 3,
            status: 'measured',
        },
    ]
    report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    report.coverage.mainThread = { status: 'measured', evidenceLevel: 'runtime-observation' }
    return report
}

export interface AnimationRumV2GoldenCase {
    readonly name: string
    readonly accepted: boolean
    readonly payload: () => unknown
}

export const ANIMATION_RUM_V2_GOLDEN_CASES: readonly AnimationRumV2GoldenCase[] = [
    { name: 'valid normalized page report', accepted: true, payload: createAnimationRumV2GoldenReport },
    { name: 'valid normalized target direct report', accepted: true, payload: validTargetDirect },
    { name: 'valid normalized target temporal partial report', accepted: true, payload: validTargetTemporalPartial },
    { name: 'valid window-capped frame report marked partial', accepted: true, payload: validWindowCappedFramePartial },
    { name: 'valid document-lifetime metric unaffected by capture cap', accepted: true, payload: validWindowCappedDocumentLifetime },
    {
        name: 'unknown root field',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), futureField: true }),
    },
    {
        name: 'missing root field',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport() as unknown as Record<string, unknown>
            delete report.captureQuality
            return report
        },
    },
    {
        name: 'wrong protocol marker',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), contractVersion: 3 }),
    },
    {
        name: 'page report with target identity',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), targetKey: 'hero-canvas' }),
    },
    {
        name: 'target report without parent identity',
        accepted: false,
        payload: () => ({ ...validTargetDirect(), parentCaptureId: null }),
    },
    {
        name: 'target report parenting itself',
        accepted: false,
        payload: () => {
            const report = validTargetDirect()
            report.parentCaptureId = report.captureId
            return report
        },
    },
    {
        name: 'target report with high-cardinality-shaped key',
        accepted: false,
        payload: () => ({ ...validTargetDirect(), targetKey: 'order-550e8400-e29b-41d4-a716-446655440000' }),
    },
    {
        name: 'target report using page relation',
        accepted: false,
        payload: () => {
            const report = validTargetDirect()
            report.metrics[0]!.relation = 'page-window'
            return report
        },
    },
    {
        name: 'frame metric falsely marked target direct',
        accepted: false,
        payload: () => {
            const report = validTargetTemporalPartial()
            report.metrics[0]!.relation = 'target-direct'
            return report
        },
    },
    {
        name: 'nested selector and DOM text channel',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport() as unknown as { context: Record<string, unknown> }
            report.context.selector = '#account-email'
            report.context.text = 'private DOM copy'
            return report
        },
    },
    {
        name: 'unknown metric identifier',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics[0]!.metricId = 'custom.metric.channel'
            return report
        },
    },
    {
        name: 'duplicate metric identity and relation',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics.push(clone(report.metrics[0]!))
            return report
        },
    },
    {
        name: 'measured metric with null value',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics[0]!.value = null
            return report
        },
    },
    {
        name: 'unavailable metric with a numeric value',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            Object.assign(report.metrics[0]!, { status: 'unsupported', value: 0, samples: 0 })
            return report
        },
    },
    {
        name: 'provider evidence with impossible loss arithmetic',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.providerEvidence['browser-core']!.frameCadence!.dropped = 1
            return report
        },
    },
    {
        name: 'measured metric hiding provider truncation',
        accepted: false,
        payload: () => {
            const report = validTargetTemporalPartial()
            report.metrics[0]!.status = 'measured'
            return report
        },
    },
    {
        name: 'measured capture-window metric hiding a capped window',
        accepted: false,
        payload: () => {
            const report = validWindowCappedFramePartial()
            report.metrics[0]!.status = 'measured'
            report.coverage.frameCadence = { status: 'measured', evidenceLevel: 'runtime-observation' }
            return report
        },
    },
    {
        name: 'measured frame metric hiding insufficient frame evidence',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.captureQuality = {
                sufficiency: 'insufficient',
                integrity: 'complete',
                reasons: ['insufficient-frame-samples'],
                adapterErrorCount: 0,
            }
            return report
        },
    },
    {
        name: 'capture quality hiding provider loss',
        accepted: false,
        payload: () => {
            const report = validTargetTemporalPartial()
            report.captureQuality = { sufficiency: 'sufficient', integrity: 'complete', reasons: [], adapterErrorCount: 0 }
            return report
        },
    },
    {
        name: 'noncanonical quality reason ordering',
        accepted: false,
        payload: () => {
            const report = validTargetTemporalPartial()
            report.captureQuality.reasons = ['window-capped', 'provider-truncated']
            report.context.windowDurationMs = 604_800_000
            report.context.windowDurationCapped = true
            return report
        },
    },
    {
        name: 'metric without its required capability',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics[0] = {
                metricId: 'main.long-task-duration.p95',
                relation: 'page-window',
                owner: 'browser-core',
                value: 55,
                samples: 3,
                status: 'measured',
            }
            report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
            report.coverage.mainThread = { status: 'measured', evidenceLevel: 'runtime-observation' }
            return report
        },
    },
    {
        name: 'decreasing percentile distribution',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics.push({
                metricId: 'frame.duration.p50',
                relation: 'page-window',
                owner: 'browser-core',
                value: 100,
                samples: 120,
                status: 'measured',
            })
            return report
        },
    },
    {
        name: 'fractional count metric',
        accepted: false,
        payload: () => {
            const report = longTaskReport()
            report.metrics[0]!.value = 1.5
            return report
        },
    },
    {
        name: 'distribution with a measured zero population',
        accepted: false,
        payload: () => {
            const report = longTaskReport()
            Object.assign(report.metrics[0]!, { value: 0, samples: 0 })
            return report
        },
    },
    {
        name: 'provider changes version across metric families',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.providerEvidence['browser-core']!.mainThread = provider('0.2.0')
            return report
        },
    },
    {
        name: 'payload beyond the wire byte limit',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), padding: 'x'.repeat(70_000) }),
    },
    {
        name: 'metric count beyond the wire limit',
        accepted: false,
        payload: () => {
            const report = createAnimationRumV2GoldenReport()
            report.metrics = Array.from({ length: 129 }, () => clone(report.metrics[0]!))
            return report
        },
    },
    {
        name: 'capture outside the accepted time window',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), capturedAt: '2025-01-01T00:00:00.000Z' }),
    },
    {
        name: 'nonexistent calendar date',
        accepted: false,
        payload: () => ({ ...createAnimationRumV2GoldenReport(), capturedAt: '2026-02-31T07:59:00.000Z' }),
    },
] as const
