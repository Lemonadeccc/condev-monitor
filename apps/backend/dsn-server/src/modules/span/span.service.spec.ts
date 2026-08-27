import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'

import { SpanService } from './span.service'

function trackingPayload() {
    const report = createAnimationRumV2GoldenReport()
    return {
        ...report,
        event_type: 'animation_rum',
        message: '',
        _eventId: report.eventId,
    }
}

function admissionResult() {
    const report = createAnimationRumV2GoldenReport()
    return {
        accepted: 1,
        queued: 1,
        duplicates: 0,
        receipts: [
            {
                eventId: report.eventId,
                captureId: report.captureId,
                receivedAt: '2026-08-27T08:00:00.000Z',
                deliveryState: 'pending' as const,
                duplicate: false,
            },
        ],
    }
}

function createService() {
    const writer = {
        writeTrackingBatch: jest.fn().mockResolvedValue({ persistedVia: 'kafka' }),
    }
    const inbound = {
        filter: jest.fn((items: Record<string, unknown>[]) => ({ accepted: items, rejected: 0 })),
    }
    const admission = {
        admitBatch: jest.fn().mockResolvedValue(admissionResult()),
    }
    const service = new SpanService(
        {} as never,
        {} as never,
        {} as never,
        { get: jest.fn() } as never,
        writer as never,
        inbound as never,
        admission as never
    )
    return { service, writer, inbound, admission }
}

describe('SpanService Animation RUM v2 tracking routing', () => {
    it('routes a text/plain v2-only beacon exclusively through durable admission', async () => {
        const { service, writer, inbound, admission } = createService()
        const payload = trackingPayload()

        const result = await service.tracking('app-12345678', JSON.stringify(payload))

        expect(admission.admitBatch).toHaveBeenCalledWith('app-12345678', [payload])
        expect(inbound.filter).not.toHaveBeenCalled()
        expect(writer.writeTrackingBatch).not.toHaveBeenCalled()
        expect(result).toEqual({
            ok: true,
            persistedVia: 'postgres-outbox',
            animationRumV2: admissionResult(),
        })
    })

    it('admits v2 before writing the ordinary lane in a mixed batch', async () => {
        const { service, writer, inbound, admission } = createService()
        const ordinary = { event_type: 'performance', message: 'navigation' }
        const v2 = trackingPayload()

        const result = await service.tracking('app-12345678', [ordinary, v2])

        expect(admission.admitBatch).toHaveBeenCalledWith('app-12345678', [v2])
        expect(inbound.filter).toHaveBeenCalledWith([ordinary])
        expect(writer.writeTrackingBatch).toHaveBeenCalledWith('app-12345678', [ordinary])
        expect(admission.admitBatch.mock.invocationCallOrder[0]).toBeLessThan(writer.writeTrackingBatch.mock.invocationCallOrder[0]!)
        expect(result).toEqual({
            ok: true,
            persistedVia: 'kafka',
            animationRumV2: admissionResult(),
        })
    })

    it('isolates a terminal v2 rejection so a mixed ordinary event is not lost', async () => {
        const { service, writer, inbound, admission } = createService()
        admission.admitBatch.mockRejectedValueOnce(
            new ForbiddenException({ message: 'Animation RUM v2 is not enabled', error: 'RUM_V2_NOT_ENABLED' })
        )
        const ordinary = { event_type: 'performance', message: 'navigation' }

        const result = await service.tracking('app-12345678', [ordinary, trackingPayload()])

        expect(inbound.filter).toHaveBeenCalledWith([ordinary])
        expect(writer.writeTrackingBatch).toHaveBeenCalledWith('app-12345678', [ordinary])
        expect(result).toEqual({
            ok: true,
            persistedVia: 'kafka',
            animationRumV2Rejected: {
                count: 1,
                reasons: [{ rejected: 1, status: 403, error: 'RUM_V2_NOT_ENABLED' }],
            },
        })
    })

    it('keeps a retryable v2 failure ahead of mixed ordinary writes', async () => {
        const { service, writer, inbound, admission } = createService()
        admission.admitBatch.mockRejectedValueOnce(
            new ServiceUnavailableException({ message: 'Temporarily unavailable', error: 'RUM_V2_UNAVAILABLE' })
        )

        await expect(
            service.tracking('app-12345678', [{ event_type: 'performance', message: 'navigation' }, trackingPayload()])
        ).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'RUM_V2_UNAVAILABLE' }),
            status: 503,
        })
        expect(inbound.filter).not.toHaveBeenCalled()
        expect(writer.writeTrackingBatch).not.toHaveBeenCalled()
    })

    it('isolates an unknown animation version in mixed traffic but rejects it when sent alone', async () => {
        const { service, writer, inbound, admission } = createService()
        const ordinary = { event_type: 'performance', message: 'navigation' }
        const unknown = { event_type: 'animation_rum', contractVersion: 3, snapshotSchemaVersion: 1 }

        await expect(service.tracking('app-12345678', unknown)).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'UNSUPPORTED_ANIMATION_RUM_VERSION' }),
            status: 400,
        })
        const mixedResult = await service.tracking('app-12345678', [ordinary, unknown])

        expect(admission.admitBatch).not.toHaveBeenCalled()
        expect(inbound.filter).toHaveBeenCalledWith([ordinary])
        expect(writer.writeTrackingBatch).toHaveBeenCalledWith('app-12345678', [ordinary])
        expect(mixedResult).toEqual({
            ok: true,
            persistedVia: 'kafka',
            animationRumV2Rejected: {
                count: 1,
                reasons: [{ rejected: 1, status: 400, error: 'UNSUPPORTED_ANIMATION_RUM_VERSION' }],
            },
        })
    })
})
