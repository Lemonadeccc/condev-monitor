import { createAnimationRumV2GoldenReport, createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope, buildAnimationRumV3KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { ClickhouseWriterService } from './clickhouse-writer.service'

// cspell:ignore noncanonical

function serviceWithInsert(insert: jest.Mock) {
    const service = new ClickhouseWriterService({
        get: (key: string) => {
            if (key === 'CLICKHOUSE_DATABASE') return 'lemonade'
            if (key === 'CLICKHOUSE_URL') return 'http://localhost:8123'
            return ''
        },
    } as any)
    ;(service as unknown as { client: { insert: jest.Mock } }).client = { insert }
    return service
}

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

function unsupportedGpuEnvelope() {
    return envelopeFor(report => {
        report.capabilities['renderer-adapter'] = 'supported'
        report.capabilities['gpu-timer-query'] = 'unsupported'
        report.providerEvidence = {}
        report.metrics = [
            {
                metricId: 'renderer.gpu-frame.p95',
                relation: 'adapter',
                owner: 'renderer-adapter',
                value: null,
                samples: null,
                status: 'unsupported',
            },
        ]
        report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
        report.coverage.renderer = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    })
}

function v3EnvelopeFor() {
    const report = createAnimationRumV3GoldenReport()
    const receivedAt = new Date()
    report.capturedAt = new Date(receivedAt.getTime() - 1_000).toISOString()
    return buildAnimationRumV3KafkaEnvelope({
        appId: 'app-12345678',
        report,
        receivedAt: receivedAt.toISOString(),
    })
}

describe('ClickhouseWriterService Animation RUM v2', () => {
    it('writes provider and metric children before the capture completion marker', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)

        await service.insertAnimationRumV2(envelopeFor())

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_provider_evidence_v2',
            'lemonade.animation_rum_metrics_v2',
            'lemonade.animation_rum_captures_v2',
        ])
    })

    it('does not write a completion marker after a child insert fails', async () => {
        const insert = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('metric insert failed'))
        const service = serviceWithInsert(insert)

        await expect(service.insertAnimationRumV2(envelopeFor())).rejects.toThrow('metric insert failed')

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_provider_evidence_v2',
            'lemonade.animation_rum_metrics_v2',
        ])
    })

    it('does not write metrics or completion after provider evidence fails', async () => {
        const insert = jest.fn().mockRejectedValueOnce(new Error('provider insert failed'))
        const service = serviceWithInsert(insert)

        await expect(service.insertAnimationRumV2(envelopeFor())).rejects.toThrow('provider insert failed')

        expect(insert.mock.calls.map(call => call[0].table)).toEqual(['lemonade.animation_rum_provider_evidence_v2'])
    })

    it('skips an empty provider batch without skipping metrics or completion', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const envelope = envelopeFor(report => {
            report.providerEvidence = {}
            report.metrics[0] = { ...report.metrics[0]!, value: null, samples: null, status: 'unsupported' }
            report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
        })

        await service.insertAnimationRumV2(envelope)

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_metrics_v2',
            'lemonade.animation_rum_captures_v2',
        ])
    })

    it('rejects an unknown metric before the first ClickHouse insert', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const envelope = envelopeFor()
        envelope.info.animationRum.metrics[0]!.metricId = 'custom.unregistered.metric'

        await expect(service.insertAnimationRumV2(envelope)).rejects.toMatchObject({
            codes: expect.arrayContaining(['unknown_metric_id']),
        })
        expect(insert).not.toHaveBeenCalled()
    })

    it('preserves unsupported GPU capability evidence from Kafka in ClickHouse rows', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)

        await service.insertAnimationRumV2(unsupportedGpuEnvelope())

        const metricInsert = insert.mock.calls.find(call => call[0].table.endsWith('.animation_rum_metrics_v2'))?.[0]
        expect(metricInsert?.values).toEqual([
            expect.objectContaining({
                metric_id: 'renderer.gpu-frame.p95',
                owner: 'renderer-adapter',
                relation: 'adapter',
                value: null,
                samples: null,
                status: 'unsupported',
            }),
        ])
        const captureInsert = insert.mock.calls.find(call => call[0].table.endsWith('.animation_rum_captures_v2'))?.[0]
        expect(JSON.parse(captureInsert?.values[0].capabilities_json)).toMatchObject({
            'renderer-adapter': 'supported',
            'gpu-timer-query': 'unsupported',
        })
    })
})

describe('ClickhouseWriterService Animation RUM v3', () => {
    it('writes v3 children before the capture completion marker', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)

        await service.insertAnimationRumV3(v3EnvelopeFor())

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_soft_navigation_provider_evidence_v3',
            'lemonade.animation_rum_soft_navigation_metrics_v3',
            'lemonade.animation_rum_soft_navigation_captures_v3',
        ])
        expect(insert.mock.calls[1]![0].values).toHaveLength(3)
    })

    it('does not write the completion marker after a v3 child insert fails', async () => {
        const insert = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('metric insert failed'))
        const service = serviceWithInsert(insert)

        await expect(service.insertAnimationRumV3(v3EnvelopeFor())).rejects.toThrow('metric insert failed')

        expect(insert.mock.calls.map(call => call[0].table)).toEqual([
            'lemonade.animation_rum_soft_navigation_provider_evidence_v3',
            'lemonade.animation_rum_soft_navigation_metrics_v3',
        ])
    })

    it('validates the complete v3 plan before the first insert', async () => {
        const insert = jest.fn().mockResolvedValue(undefined)
        const service = serviceWithInsert(insert)
        const envelope = v3EnvelopeFor()
        envelope.info.animationSoftNavigationRum.metrics[0]!.metricId = 'vital.frame.p95' as any

        await expect(service.insertAnimationRumV3(envelope)).rejects.toMatchObject({
            codes: expect.arrayContaining(['noncanonical_metric_set']),
        })
        expect(insert).not.toHaveBeenCalled()
    })
})
