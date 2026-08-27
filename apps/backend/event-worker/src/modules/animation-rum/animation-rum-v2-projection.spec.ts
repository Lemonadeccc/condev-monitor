import { ANIMATION_RUM_FAMILIES, ANIMATION_RUM_V2_CAPABILITIES } from '@condev-monitor/animation-rum-contract'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { projectAnimationRumV2Rows } from './animation-rum-v2-projection'

describe('projectAnimationRumV2Rows', () => {
    it('derives canonical metric identity and rebuilds closed JSON maps', () => {
        const report = createAnimationRumV2GoldenReport()
        ;(report.capabilities as unknown as Record<string, unknown>).userEmail = 'must-not-persist@example.test'
        ;(report.coverage as unknown as Record<string, unknown>).selector = '#must-not-persist'
        ;(report.providerEvidence as unknown as Record<string, unknown>).arbitraryOwner = { raw: 'must-not-persist' }

        const rows = projectAnimationRumV2Rows('app-12345678', report, '2026-08-27 07:59:00.000', '2026-08-27 08:00:00.000')

        expect(rows.metricRows).toEqual([
            expect.objectContaining({
                metric_id: 'frame.duration.p95',
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'page-window',
                owner: 'browser-core',
            }),
        ])
        expect(rows.providerRows).toEqual([
            expect.objectContaining({ owner: 'browser-core', family: 'frameCadence', provider_version: '0.1.0' }),
        ])
        expect(Object.keys(JSON.parse(String(rows.captureRow.capabilities_json)))).toEqual([...ANIMATION_RUM_V2_CAPABILITIES])
        expect(Object.keys(JSON.parse(String(rows.captureRow.coverage_json)))).toEqual([...ANIMATION_RUM_FAMILIES])
        expect(JSON.stringify(rows)).not.toContain('must-not-persist')
        expect(rows.captureRow).toEqual(
            expect.objectContaining({
                provider_evidence_count: 1,
                metric_count: 1,
                parent_capture_id: '',
                target_key: '',
            })
        )
    })

    it('preserves only explicit target identity and evidence relation', () => {
        const report = createAnimationRumV2GoldenReport()
        report.scope = 'target'
        report.parentCaptureId = 'capture_parent_1234'
        report.targetKey = 'hero-canvas'
        report.metrics[0]!.relation = 'target-temporal-overlap'

        const rows = projectAnimationRumV2Rows('app-12345678', report, '2026-08-27 07:59:00.000', '2026-08-27 08:00:00.000')

        expect(rows.captureRow).toEqual(
            expect.objectContaining({
                scope: 'target',
                parent_capture_id: 'capture_parent_1234',
                target_key: 'hero-canvas',
            })
        )
        expect(rows.metricRows[0]).toEqual(expect.objectContaining({ relation: 'target-temporal-overlap' }))
    })

    it.each([
        [true, 1],
        [false, 0],
        [null, null],
    ] as const)('maps reduced motion %s to its nullable ClickHouse representation', (reducedMotion, expected) => {
        const report = createAnimationRumV2GoldenReport()
        report.context.reducedMotion = reducedMotion

        const rows = projectAnimationRumV2Rows('app-12345678', report, '2026-08-27 07:59:00.000', '2026-08-27 08:00:00.000')

        expect(rows.captureRow.reduced_motion).toBe(expected)
    })

    it('produces stable rows when valid input maps and metrics arrive in a different order', () => {
        const first = createAnimationRumV2GoldenReport()
        first.metrics.unshift({
            metricId: 'frame.duration.p50',
            relation: 'page-window',
            owner: 'browser-core',
            value: 16,
            samples: 120,
            status: 'measured',
        })
        const second = JSON.parse(JSON.stringify(first)) as typeof first
        second.metrics.reverse()
        second.capabilities = Object.fromEntries(Object.entries(second.capabilities).reverse()) as typeof second.capabilities
        second.coverage = Object.fromEntries(Object.entries(second.coverage).reverse()) as typeof second.coverage

        const args = ['app-12345678', '2026-08-27 07:59:00.000', '2026-08-27 08:00:00.000'] as const
        expect(projectAnimationRumV2Rows(args[0], first, args[1], args[2])).toEqual(
            projectAnimationRumV2Rows(args[0], second, args[1], args[2])
        )
    })

    it('fails before storage projection when a metric is absent from the canonical registry', () => {
        const report = createAnimationRumV2GoldenReport()
        report.metrics[0]!.metricId = 'custom.unregistered.metric'

        expect(() => projectAnimationRumV2Rows('app-12345678', report, '2026-08-27 07:59:00.000', '2026-08-27 08:00:00.000')).toThrow(
            'canonical registry'
        )
    })
})
