import { SpanController } from './span.controller'

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
        const controller = new SpanController(spanService as any, rateLimiter as any)
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
})
