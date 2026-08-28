import { createAnimationRumV2GoldenReport, createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope, buildAnimationRumV3KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumClickhouseService } from './animation-rum-clickhouse.service'

function envelopeFor(mutator?: (report: ReturnType<typeof createAnimationRumV2GoldenReport>) => void) {
    const report = createAnimationRumV2GoldenReport()
    const receivedAt = new Date()
    report.capturedAt = new Date(receivedAt.getTime() - 60_000).toISOString()
    mutator?.(report)
    return buildAnimationRumV2KafkaEnvelope({
        appId: 'app-12345678',
        report,
        receivedAt: receivedAt.toISOString(),
    })
}

function gpuUnavailableEnvelope(
    timerState: 'supported' | 'unsupported' | 'disabled' | 'unknown',
    status: 'not-observed' | 'not-instrumented' | 'unsupported' | 'unknown'
) {
    return envelopeFor(report => {
        report.capabilities['renderer-adapter'] = 'supported'
        report.capabilities['gpu-timer-query'] = timerState
        report.providerEvidence = {}
        report.metrics = [
            {
                metricId: 'renderer.gpu-frame.p95',
                relation: 'adapter',
                owner: 'renderer-adapter',
                value: null,
                samples: null,
                status,
            },
        ]
        report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
        report.coverage.renderer = {
            status,
            evidenceLevel: status === 'not-observed' ? 'runtime-observation' : 'unsupported-or-unknown',
        }
    })
}

function serviceWithInsert(insert: jest.Mock) {
    const clickhouse = { insert }
    const config = { get: (key: string) => (key === 'CLICKHOUSE_DATABASE' ? 'lemonade' : undefined) }
    return new AnimationRumClickhouseService(clickhouse as never, config as never)
}

describe('AnimationRumClickhouseService v2 projection', () => {
    it('writes provider and metric children before the capture completion marker', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)

        await service.insertV2(envelopeFor())

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_provider_evidence_v2',
            'lemonade.animation_rum_metrics_v2',
            'lemonade.animation_rum_captures_v2',
        ])
    })

    it('does not write the completion marker after a child insert fails', async () => {
        const insert = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('metric insert failed'))
        const service = serviceWithInsert(insert)

        await expect(service.insertV2(envelopeFor())).rejects.toThrow('metric insert failed')

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_provider_evidence_v2',
            'lemonade.animation_rum_metrics_v2',
        ])
    })

    it('skips empty provider evidence while retaining metrics and completion', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const envelope = envelopeFor(report => {
            report.providerEvidence = {}
            report.metrics[0] = { ...report.metrics[0]!, value: null, samples: null, status: 'unsupported' }
            report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
        })

        await service.insertV2(envelope)

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_metrics_v2',
            'lemonade.animation_rum_captures_v2',
        ])
    })

    it('validates the complete envelope before the first insert', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const envelope = envelopeFor()
        envelope.info.animationRum.metrics[0]!.metricId = 'custom.unregistered.metric'

        await expect(service.insertV2(envelope)).rejects.toMatchObject({
            codes: expect.arrayContaining(['unknown_metric_id']),
        })
        expect(insert).not.toHaveBeenCalled()
    })

    it.each([
        ['supported', 'not-observed'],
        ['disabled', 'not-instrumented'],
        ['unsupported', 'unsupported'],
        ['unknown', 'unknown'],
    ] as const)('preserves GPU timer capability %s and metric status %s on the direct ClickHouse path', async (timerState, status) => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)

        await service.insertV2(gpuUnavailableEnvelope(timerState, status))

        const metricInsert = insert.mock.calls.find(call => call[0].table.endsWith('.animation_rum_metrics_v2'))?.[0]
        expect(metricInsert?.values).toEqual([
            expect.objectContaining({
                metric_id: 'renderer.gpu-frame.p95',
                owner: 'renderer-adapter',
                relation: 'adapter',
                value: null,
                samples: null,
                status,
            }),
        ])
        const captureInsert = insert.mock.calls.find(call => call[0].table.endsWith('.animation_rum_captures_v2'))?.[0]
        expect(JSON.parse(captureInsert?.values[0].capabilities_json)).toMatchObject({
            'renderer-adapter': 'supported',
            'gpu-timer-query': timerState,
        })
    })
})

describe('AnimationRumClickhouseService v3 soft-navigation projection', () => {
    it('writes v3 evidence and metrics before the isolated completion marker', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const report = createAnimationRumV3GoldenReport()
        const receivedAt = new Date()
        report.capturedAt = new Date(receivedAt.getTime() - 60_000).toISOString()
        const envelope = buildAnimationRumV3KafkaEnvelope({
            appId: 'app-12345678',
            report,
            receivedAt: receivedAt.toISOString(),
            nowEpochMs: receivedAt.getTime(),
        })

        await service.insertV3SoftNavigation(envelope)

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_soft_navigation_provider_evidence_v3',
            'lemonade.animation_rum_soft_navigation_metrics_v3',
            'lemonade.animation_rum_soft_navigation_captures_v3',
        ])
        expect(insert.mock.calls[1]?.[0].values).toHaveLength(3)
    })

    it('does not write the v3 completion marker when a child insert fails', async () => {
        const insert = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('metric insert failed'))
        const service = serviceWithInsert(insert)
        const report = createAnimationRumV3GoldenReport()
        const receivedAt = new Date()
        report.capturedAt = new Date(receivedAt.getTime() - 60_000).toISOString()
        const envelope = buildAnimationRumV3KafkaEnvelope({
            appId: 'app-12345678',
            report,
            receivedAt: receivedAt.toISOString(),
            nowEpochMs: receivedAt.getTime(),
        })

        await expect(service.insertV3SoftNavigation(envelope)).rejects.toThrow('metric insert failed')
        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_soft_navigation_provider_evidence_v3',
            'lemonade.animation_rum_soft_navigation_metrics_v3',
        ])
    })
})
