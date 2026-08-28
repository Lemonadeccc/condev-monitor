import { createAnimationRumV2GoldenReport, createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { ANIMATION_RUM_FAMILIES } from '../../shared/animation-rum-v1'
import { SpanController } from './span.controller'

function animationReport() {
    return {
        contractVersion: 1,
        snapshotSchemaVersion: 1,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        capturedAt: new Date().toISOString(),
        release: 'blocked-1',
        dist: '',
        environment: '',
        sdkVersion: '',
        monitorVersion: '1.0.0',
        sampleRate: 1,
        samplingPolicyVersion: 1,
        context: { windowDurationMs: 10_000, windowDurationCapped: false },
        capabilities: {},
        coverage: Object.fromEntries(
            ANIMATION_RUM_FAMILIES.map(family => [
                family,
                {
                    status: 'unsupported',
                    evidenceLevel: 'unsupported-or-unknown',
                },
            ])
        ),
        metrics: [{ family: 'frameCadence', name: 'frameDurationMs', stat: 'p95', unit: 'ms', value: 16, samples: 1, status: 'measured' }],
    }
}

function animationV2Report() {
    const report = createAnimationRumV2GoldenReport()
    return { ...report, event_type: 'animation_rum', message: '', _eventId: report.eventId }
}

describe('SpanController', () => {
    it('parses string beacon bodies before computing rate-limit cost', async () => {
        const spanService = {
            tracking: jest.fn(),
        }
        const rateLimiter = {
            check: jest.fn().mockReturnValue({
                exceeded: true,
                retryAfterSeconds: 10,
                resetTimestamp: 1234567890,
            }),
        }
        const controller = new SpanController(spanService as any, rateLimiter as any, {} as any, {} as any, {} as any)
        const res = {
            status: jest.fn().mockReturnThis(),
            header: jest.fn().mockReturnThis(),
        }

        const result = controller.tracking(
            'app-1',
            JSON.stringify([
                { event_type: 'error', message: 'a' },
                { event_type: 'error', message: 'b' },
                { event_type: 'error', message: 'c' },
            ]),
            res as any
        )

        expect(rateLimiter.check).toHaveBeenCalledWith('app-1', 3)
        expect(spanService.tracking).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(429)
        expect(result).toEqual({
            ok: false,
            reason: 'rate_limited',
            retryAfter: 10,
        })
    })

    it('charges animation tracking by bounded metric count', () => {
        const rateLimiter = { check: jest.fn().mockReturnValue({ exceeded: true, retryAfterSeconds: 1, resetTimestamp: 2 }) }
        const controller = new SpanController({ tracking: jest.fn() } as any, rateLimiter as any, {} as any, {} as any, {} as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }

        controller.tracking(
            'app-1',
            { event_type: 'animation_rum', contractVersion: 1, snapshotSchemaVersion: 1, metrics: [{}, {}, {}, {}] },
            res as any
        )

        expect(rateLimiter.check).toHaveBeenCalledWith('app-1', 4)
    })

    it('keeps the legacy unit rate cost for a custom event named animation_rum', () => {
        const rateLimiter = { check: jest.fn().mockReturnValue({ exceeded: false }) }
        const spanService = { tracking: jest.fn().mockReturnValue({ ok: true }) }
        const controller = new SpanController(spanService as any, rateLimiter as any, {} as any, {} as any, {} as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }

        controller.tracking('legacy app id', { event_type: 'animation_rum', message: 'legacy custom event' }, res as any)

        expect(rateLimiter.check).toHaveBeenCalledWith('legacy app id', 1)
        expect(spanService.tracking).toHaveBeenCalledTimes(1)
    })

    it('accepts the one-character v2 app id boundary', () => {
        const rateLimiter = { check: jest.fn().mockReturnValue({ exceeded: false }) }
        const spanService = { tracking: jest.fn().mockReturnValue({ ok: true }) }
        const controller = new SpanController(spanService as any, rateLimiter as any, {} as any, {} as any, {} as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }

        controller.tracking('a', animationV2Report(), res as any)

        expect(rateLimiter.check).toHaveBeenCalledWith('a', 1)
        expect(spanService.tracking).toHaveBeenCalledTimes(1)
    })

    it('leaves a mixed ordinary lane available when a v2 app id is invalid', () => {
        const rateLimiter = { check: jest.fn().mockReturnValue({ exceeded: false }) }
        const spanService = { tracking: jest.fn().mockReturnValue({ ok: true }) }
        const controller = new SpanController(spanService as any, rateLimiter as any, {} as any, {} as any, {} as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }
        const body = [{ event_type: 'performance', message: 'navigation' }, animationV2Report()]

        controller.tracking('legacy app id', body, res as any)

        expect(spanService.tracking).toHaveBeenCalledWith('legacy app id', body)
    })

    it('applies the shared inbound policy before the dedicated route persists', async () => {
        const rateLimiter = { check: jest.fn() }
        const writer = { writeAnimationRum: jest.fn() }
        const inbound = {
            filter: jest.fn().mockReturnValue({ accepted: [], rejected: 1, reasons: ['blocked_release'] }),
        }
        const controller = new SpanController({} as any, rateLimiter as any, writer as any, inbound as any, {} as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }

        await expect(controller.animationRum('app-1', animationReport(), res as any)).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'ANIMATION_RUM_POLICY_REJECTED' }),
        })
        expect(inbound.filter).toHaveBeenCalledWith([expect.objectContaining({ event_type: 'animation_rum', _eventId: 'event_12345678' })])
        expect(rateLimiter.check).not.toHaveBeenCalled()
        expect(writer.writeAnimationRum).not.toHaveBeenCalled()
    })

    it('admits only the dedicated v3 lane and returns its exact receipt wrapper', async () => {
        const report = createAnimationRumV3GoldenReport()
        const admission = {
            admitBatch: jest.fn().mockResolvedValue({
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
            }),
        }
        const rateLimiter = { check: jest.fn().mockReturnValue({ exceeded: false }) }
        const controller = new SpanController({} as any, rateLimiter as any, {} as any, {} as any, admission as any)
        const res = { status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis() }
        const payload = { ...report, event_type: 'animation_soft_navigation_rum', message: '', _eventId: report.eventId }

        await expect(controller.trackingV3SoftNavigation('app-1', JSON.stringify(payload), res as any)).resolves.toEqual({
            ok: true,
            persistedVia: 'postgres-outbox',
            animationRumV3SoftNavigation: expect.objectContaining({ accepted: 1, queued: 1, duplicates: 0 }),
        })
        expect(rateLimiter.check).toHaveBeenCalledWith('app-1', 3)
        expect(admission.admitBatch).toHaveBeenCalledWith('app-1', [payload])
    })

    it('rejects malformed JSON on tracking-v3 without invoking admission', async () => {
        const admission = { admitBatch: jest.fn() }
        const controller = new SpanController(
            {} as any,
            { check: jest.fn().mockReturnValue({ exceeded: false }) } as any,
            {} as any,
            {} as any,
            admission as any
        )

        await expect(controller.trackingV3SoftNavigation('app-1', '{bad', {} as any)).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'INVALID_ANIMATION_RUM_V3' }),
        })
        expect(admission.admitBatch).not.toHaveBeenCalled()
    })
})
