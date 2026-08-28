import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { BadRequestException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'

import { AnimationRumV3AdmissionService } from '../ingest/animation-rum-v3-admission.service'
import { InboundFilterService } from '../ingest/inbound-filter.service'
import { IngestWriterService } from '../ingest/ingest-writer.service'
import { RateLimiterService } from '../ingest/rate-limiter.service'
import { SpanController } from './span.controller'
import { SpanService } from './span.service'

describe('POST /tracking-v3/:app_id', () => {
    let app: INestApplication
    const admission = { admitBatch: jest.fn() }

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            controllers: [SpanController],
            providers: [
                { provide: SpanService, useValue: {} },
                { provide: RateLimiterService, useValue: { check: () => ({ exceeded: false }) } },
                { provide: IngestWriterService, useValue: {} },
                { provide: InboundFilterService, useValue: {} },
                { provide: AnimationRumV3AdmissionService, useValue: admission },
            ],
        }).compile()
        app = module.createNestApplication()
        app.setGlobalPrefix('dsn-api')
        await app.init()
    })

    afterAll(async () => {
        await app.close()
    })

    beforeEach(() => admission.admitBatch.mockReset())

    it('returns the exact isolated v3 response contract', async () => {
        const report = createAnimationRumV3GoldenReport()
        const payload = { ...report, event_type: 'animation_soft_navigation_rum', message: '', _eventId: report.eventId }
        admission.admitBatch.mockResolvedValue({
            accepted: 1,
            queued: 1,
            duplicates: 0,
            receipts: [
                {
                    eventId: report.eventId,
                    captureId: report.captureId,
                    receivedAt: '2026-08-29T08:00:00.000Z',
                    deliveryState: 'pending',
                    duplicate: false,
                },
            ],
        })

        const response = await request(app.getHttpServer()).post('/dsn-api/tracking-v3/app-12345678').send(payload).expect(201)

        expect(response.body).toEqual({
            ok: true,
            persistedVia: 'postgres-outbox',
            animationRumV3SoftNavigation: {
                accepted: 1,
                queued: 1,
                duplicates: 0,
                receipts: [expect.objectContaining({ captureId: report.captureId, deliveryState: 'pending' })],
            },
        })
        expect(admission.admitBatch).toHaveBeenCalledWith('app-12345678', [payload])
    })

    it('does not allow a v2 payload to cross into the v3 lane', async () => {
        admission.admitBatch.mockRejectedValue(new BadRequestException({ error: 'INVALID_ANIMATION_RUM_V3' }))

        await request(app.getHttpServer())
            .post('/dsn-api/tracking-v3/app-12345678')
            .send({ event_type: 'animation_rum', contractVersion: 2 })
            .expect(400)
        expect(admission.admitBatch).toHaveBeenCalledTimes(1)
    })
})
