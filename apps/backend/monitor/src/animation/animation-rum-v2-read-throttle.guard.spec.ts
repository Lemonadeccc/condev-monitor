import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common'

import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'

function httpContext(request: unknown) {
    const response = { setHeader: jest.fn() }
    const context = {
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
        }),
    } as unknown as ExecutionContext
    return { context, response }
}

describe('AnimationRumV2ReadThrottleGuard', () => {
    it('uses only the authenticated user and app identity after JWT authentication', () => {
        const throttle = { consume: jest.fn().mockReturnValue({ allowed: true, remaining: 12, retryAfterSeconds: 0 }) }
        const guard = new AnimationRumV2ReadThrottleGuard(throttle as any)
        const { context, response } = httpContext({ user: { id: 41 }, query: { appId: 'vanillaFixture1' } })

        expect(guard.canActivate(context)).toBe(true)
        expect(throttle.consume).toHaveBeenCalledWith(41, 'vanillaFixture1')
        expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '12')
        expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
        expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
    })

    it('cannot run without an authenticated JWT actor', () => {
        const throttle = { consume: jest.fn() }
        const guard = new AnimationRumV2ReadThrottleGuard(throttle as any)
        const { context } = httpContext({ query: { appId: 'vanillaFixture1' } })

        expect(() => guard.canActivate(context)).toThrow(UnauthorizedException)
        expect(throttle.consume).not.toHaveBeenCalled()
    })

    it.each([undefined, ['vanillaFixture1'], { nested: true }, 'not:an:app'])('groups invalid raw app identities safely: %p', appId => {
        const throttle = { consume: jest.fn().mockReturnValue({ allowed: true, remaining: 12, retryAfterSeconds: 0 }) }
        const guard = new AnimationRumV2ReadThrottleGuard(throttle as any)
        const { context } = httpContext({ user: { id: 41 }, query: { appId } })

        expect(guard.canActivate(context)).toBe(true)
        expect(throttle.consume).toHaveBeenCalledWith(41, '<invalid-app-id>')
    })

    it('returns a generic 429 with Retry-After and private no-store headers', () => {
        const throttle = { consume: jest.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 17 }) }
        const guard = new AnimationRumV2ReadThrottleGuard(throttle as any)
        const { context, response } = httpContext({ user: { id: 41 }, query: { appId: 'unknownFixture1' } })

        try {
            guard.canActivate(context)
            throw new Error('Expected guard to reject the request')
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException)
            expect((error as HttpException).getStatus()).toBe(429)
            expect((error as HttpException).message).toBe('Animation RUM v2 read rate limit exceeded')
        }
        expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '17')
        expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '0')
        expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
        expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
    })
})
