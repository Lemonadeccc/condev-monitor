import { type AnimationRumV3Report } from '../v3'

export const ANIMATION_RUM_V3_GOLDEN_NOW = Date.parse('2026-08-29T08:00:00.000Z')

export function createAnimationRumV3GoldenReport(): AnimationRumV3Report {
    return {
        contractVersion: 3,
        snapshotSchemaVersion: 1,
        captureKind: 'soft-navigation',
        eventId: 'event_soft_navigation_1234',
        captureId: 'capture_soft_navigation_1234',
        scope: 'page',
        parentCaptureId: null,
        targetKey: null,
        capturedAt: '2026-08-29T07:59:00.000Z',
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '0.1.0',
        monitorVersion: '0.1.0',
        sampleRate: 0.1,
        samplingPolicyVersion: 3,
        context: {
            routeKey: 'catalog.product-detail',
            visibilityState: 'visible',
            reducedMotion: false,
            viewportBucket: 'large',
            dprBucket: '2',
            refreshHz: 60,
            refreshBudgetSource: 'observed',
            refreshBudgetConfidence: 'high',
            windowDurationMs: 2_500,
            windowDurationCapped: false,
            runtime: {
                framework: 'react',
                renderer: 'dom',
                backend: 'dom',
            },
        },
        capabilities: {
            'web-vitals-soft-navigation': {
                status: 'supported',
                metrics: { CLS: 'supported', INP: 'supported', LCP: 'supported' },
            },
        },
        coverage: {
            userOutcome: { status: 'measured', evidenceLevel: 'runtime-observation' },
        },
        captureQuality: {
            sufficiency: 'sufficient',
            integrity: 'complete',
            reasons: [],
        },
        providerEvidence: {
            'web-vitals-runtime': {
                userOutcome: {
                    version: '0.1.0',
                    accepted: 3,
                    retained: 3,
                    evidence: 3,
                    dropped: 0,
                    rejected: 0,
                    truncated: false,
                },
            },
        },
        metrics: [
            {
                metricId: 'vital.soft-navigation.cls.latest',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                value: 0.025,
                samples: 1,
                status: 'measured',
            },
            {
                metricId: 'vital.soft-navigation.inp.latest',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                value: 120,
                samples: 1,
                status: 'measured',
            },
            {
                metricId: 'vital.soft-navigation.lcp.latest',
                relation: 'page-window',
                owner: 'web-vitals-runtime',
                value: 1_250,
                samples: 1,
                status: 'measured',
            },
        ],
    }
}
