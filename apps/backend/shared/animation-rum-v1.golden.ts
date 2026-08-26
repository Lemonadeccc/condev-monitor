/**
 * Shared acceptance corpus for both Animation RUM v1 trust boundaries.
 *
 * The DSN ingress accepts a transport wrapper and normalizes optional metadata,
 * while the event worker accepts only that normalized report. These cases use
 * the common normalized shape so both validators must make the same accept or
 * reject decision without coupling their production package boundaries.
 */

const FAMILIES = [
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

type GoldenReport = Record<string, unknown> & {
    context: Record<string, unknown>
    capabilities: Record<string, unknown>
    coverage: Record<string, Record<string, unknown>>
    metrics: Array<Record<string, unknown>>
}

function report(): GoldenReport {
    return {
        contractVersion: 1,
        snapshotSchemaVersion: 1,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        capturedAt: new Date().toISOString(),
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '1.2.3',
        monitorVersion: '1.0.0',
        sampleRate: 0.1,
        samplingPolicyVersion: 1,
        context: {
            routeKey: 'product-detail',
            runtimeFamily: 'react',
            windowDurationMs: 10_000,
            windowDurationCapped: false,
        },
        capabilities: {
            longtask: true,
            'long-animation-frame': 'unknown',
        },
        coverage: Object.fromEntries(FAMILIES.map(family => [family, { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }])),
        metrics: [
            {
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                value: 18.5,
                samples: 120,
                status: 'measured',
            },
            {
                family: 'mainThread',
                name: 'longTaskDurationMs',
                stat: 'p95',
                unit: 'ms',
                value: null,
                samples: null,
                status: 'unsupported',
            },
        ],
    }
}

export type AnimationRumGoldenCase = {
    name: string
    accepted: boolean
    payload: () => Record<string, unknown>
}

export const ANIMATION_RUM_V1_GOLDEN_CASES: readonly AnimationRumGoldenCase[] = [
    {
        name: 'valid normalized report',
        accepted: true,
        payload: report,
    },
    {
        name: 'valid inclusive numeric boundaries',
        accepted: true,
        payload: () => {
            const value = report()
            value.sampleRate = 0.000001
            value.samplingPolicyVersion = 255
            value.context.windowDurationMs = 604_800_000
            value.context.windowDurationCapped = true
            value.metrics[0]!.value = 1e15
            value.metrics[0]!.samples = 1e9
            return value
        },
    },
    {
        name: 'unknown root field',
        accepted: false,
        payload: () => ({ ...report(), futureRootField: true }),
    },
    {
        name: 'unknown nested context field',
        accepted: false,
        payload: () => {
            const value = report()
            value.context.futureContextField = true
            return value
        },
    },
    {
        name: 'sample rate below lower bound',
        accepted: false,
        payload: () => ({ ...report(), sampleRate: 0 }),
    },
    {
        name: 'metric value above upper bound',
        accepted: false,
        payload: () => {
            const value = report()
            value.metrics[0]!.value = 1e15 + 1
            return value
        },
    },
    {
        name: 'dishonest capped measurement window',
        accepted: false,
        payload: () => {
            const value = report()
            value.context.windowDurationCapped = true
            return value
        },
    },
    {
        name: 'oversized payload',
        accepted: false,
        payload: () => ({ ...report(), padding: 'x'.repeat(70_000) }),
    },
    {
        name: 'nested identity and raw-data fields',
        accepted: false,
        payload: () => {
            const value = report()
            value.context.metadata = {
                userEmail: 'private@example.test',
                selector: '#account-email',
                rawFrames: [1, 2, 3],
            }
            return value
        },
    },
    {
        name: 'singleton arrays impersonating closed enums',
        accepted: false,
        payload: () => {
            const value = report()
            value.context.visibilityState = ['visible']
            value.metrics[0]!.family = ['frameCadence']
            value.coverage.frameCadence!.status = ['unsupported']
            return value
        },
    },
    {
        name: 'duplicate metric identity',
        accepted: false,
        payload: () => {
            const value = report()
            value.metrics.push({ ...value.metrics[0]! })
            return value
        },
    },
] as const
