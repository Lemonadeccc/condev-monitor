import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { ClickhouseWriterService } from './clickhouse-writer.service'

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
})
