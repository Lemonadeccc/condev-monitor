import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV3KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumV3ProjectorService } from './animation-rum-v3-projector.service'

function envelopeFor() {
    const receivedAt = new Date()
    const report = createAnimationRumV3GoldenReport()
    report.capturedAt = new Date(receivedAt.getTime() - 1_000).toISOString()
    return buildAnimationRumV3KafkaEnvelope({
        appId: 'app-12345678',
        report,
        receivedAt: receivedAt.toISOString(),
    })
}

describe('AnimationRumV3ProjectorService', () => {
    it('validates the exact source and message key before writing', async () => {
        const envelope = envelopeFor()
        const writer = { insertAnimationRumV3: jest.fn().mockResolvedValue(undefined) }
        const service = new AnimationRumV3ProjectorService(writer as any)

        await service.handleEnvelope(envelope, envelope.appId)

        expect(writer.insertAnimationRumV3).toHaveBeenCalledWith(envelope)
    })

    it.each([
        ['a v2 source', { source: 'animation-rum-v2' }],
        ['a v1 event type', { eventType: 'animation_rum' }],
        ['mixed v2 info', { info: { animationRum: { contractVersion: 2 } } }],
        ['an unknown field', { privateValue: 'must-not-project' }],
    ])('fails closed for %s', async (_name, mutation) => {
        const envelope = Object.assign(envelopeFor(), mutation)
        const writer = { insertAnimationRumV3: jest.fn() }
        const service = new AnimationRumV3ProjectorService(writer as any)

        await expect(service.handleEnvelope(envelope, 'app-12345678')).rejects.toMatchObject({
            codes: expect.any(Array),
        })
        expect(writer.insertAnimationRumV3).not.toHaveBeenCalled()
    })

    it('rejects a missing or mismatched Kafka key', async () => {
        const envelope = envelopeFor()
        const writer = { insertAnimationRumV3: jest.fn() }
        const service = new AnimationRumV3ProjectorService(writer as any)

        await expect(service.handleEnvelope(envelope, null)).rejects.toMatchObject({
            codes: expect.arrayContaining(['message_key_mismatch']),
        })
        await expect(service.handleEnvelope(envelope, 'other-app')).rejects.toMatchObject({
            codes: expect.arrayContaining(['message_key_mismatch']),
        })
        expect(writer.insertAnimationRumV3).not.toHaveBeenCalled()
    })

    it('propagates ClickHouse failures so Kafka can retry the same offset', async () => {
        const failure = new Error('clickhouse unavailable')
        const writer = { insertAnimationRumV3: jest.fn().mockRejectedValue(failure) }
        const service = new AnimationRumV3ProjectorService(writer as any)

        await expect(service.handleEnvelope(envelopeFor(), 'app-12345678')).rejects.toBe(failure)
    })
})
