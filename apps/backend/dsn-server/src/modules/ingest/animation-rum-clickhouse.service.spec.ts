import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

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
})
