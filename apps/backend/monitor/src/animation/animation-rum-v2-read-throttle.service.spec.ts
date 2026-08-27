import { ANIMATION_RUM_V2_READ_THROTTLE_ENFORCEMENT, AnimationRumV2ReadThrottleService } from './animation-rum-v2-read-throttle.service'

describe('AnimationRumV2ReadThrottleService', () => {
    let clockNow: number

    beforeEach(() => {
        clockNow = 1_000
    })

    const createLimiter = (policy?: ConstructorParameters<typeof AnimationRumV2ReadThrottleService>[0]) =>
        new AnimationRumV2ReadThrottleService(policy, () => clockNow)

    it('shares one fixed-window request budget for the same user and app', () => {
        const limiter = createLimiter({ requestLimit: 2, windowMs: 1_500, cleanupIntervalMs: 1_500 })

        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 2 })
    })

    it('isolates budgets by both authenticated user and app identity', () => {
        const limiter = createLimiter({ requestLimit: 1 })

        expect(limiter.consume(41, 'vanillaFixture1').allowed).toBe(true)
        expect(limiter.consume(41, 'vanillaFixture1').allowed).toBe(false)
        expect(limiter.consume(42, 'vanillaFixture1').allowed).toBe(true)
        expect(limiter.consume(41, 'anotherFixture1').allowed).toBe(true)
    })

    it('resets expired windows and reports a whole-second Retry-After', () => {
        const limiter = createLimiter({ requestLimit: 1, windowMs: 1_500, cleanupIntervalMs: 1_500 })

        expect(limiter.consume(41, 'vanillaFixture1').allowed).toBe(true)
        clockNow = 2_499
        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1 })

        clockNow = 2_500
        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
    })

    it('fails closed for a new key when the map is full without evicting an exhausted live bucket', () => {
        const limiter = createLimiter({
            requestLimit: 1,
            userRequestLimit: 10,
            windowMs: 60_000,
            maxEntries: 3,
            cleanupIntervalMs: 60_000,
        })

        limiter.consume(41, 'firstFixture1')
        expect(limiter.consume(41, 'firstFixture1').allowed).toBe(false)
        limiter.consume(41, 'secondFixture1')
        expect(limiter.consume(41, 'thirdFixture1')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 })

        const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
        expect(buckets.size).toBe(3)
        expect([...buckets.keys()]).toEqual(['user:41', 'user-app:41:firstFixture1', 'user-app:41:secondFixture1'])
        expect(limiter.consume(41, 'firstFixture1').allowed).toBe(false)
        expect(buckets.size).toBe(3)
    })

    it('cleans expired buckets opportunistically without a timer', () => {
        const limiter = createLimiter({
            requestLimit: 1,
            windowMs: 1_000,
            maxEntries: 5,
            cleanupIntervalMs: 500,
        })

        limiter.consume(41, 'firstFixture1')
        limiter.consume(41, 'secondFixture1')
        clockNow = 2_001
        limiter.consume(41, 'thirdFixture1')

        const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
        expect([...buckets.keys()]).toEqual(['user:41', 'user-app:41:thirdFixture1'])
    })

    it('uses the coarse user budget before per-app buckets so unknown apps cannot bypass the limit', () => {
        const limiter = createLimiter({
            requestLimit: 2,
            userRequestLimit: 3,
            maxEntries: 10,
        })

        expect(limiter.consume(41, 'unknownFixture1')).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
        expect(limiter.consume(41, 'unknownFixture2')).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
        expect(limiter.consume(41, 'unknownFixture3')).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
        expect(limiter.consume(41, 'unknownFixture4')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 })

        const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
        expect(buckets.has('user-app:41:unknownFixture4')).toBe(false)
    })

    it('uses the stricter remaining and blocked-until semantics across both budgets', () => {
        const limiter = createLimiter({
            requestLimit: 1,
            userRequestLimit: 2,
            windowMs: 2_000,
            cleanupIntervalMs: 2_000,
        })

        expect(limiter.consume(41, 'firstFixture1')).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
        clockNow = 1_500
        expect(limiter.consume(41, 'firstFixture1')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 2 })
    })

    it('clamps clock rollback so it neither extends nor resets a live window', () => {
        const limiter = createLimiter({
            requestLimit: 1,
            windowMs: 1_500,
            cleanupIntervalMs: 1_500,
        })

        expect(limiter.consume(41, 'vanillaFixture1').allowed).toBe(true)
        clockNow = 2_000
        expect(limiter.consume(41, 'vanillaFixture1').retryAfterSeconds).toBe(1)
        clockNow = 500
        expect(limiter.consume(41, 'vanillaFixture1')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1 })
        clockNow = 2_500
        expect(limiter.consume(41, 'vanillaFixture1').allowed).toBe(true)
    })

    it.each([
        [{ requestLimit: 0 }, 'requestLimit'],
        [{ requestLimit: 1.5 }, 'requestLimit'],
        [{ requestLimit: undefined } as unknown as { requestLimit: number }, 'requestLimit'],
        [{ userRequestLimit: Number.POSITIVE_INFINITY }, 'userRequestLimit'],
        [{ windowMs: Number.MAX_SAFE_INTEGER }, 'windowMs'],
        [{ maxEntries: 1 }, 'maxEntries'],
        [{ maxEntries: 100_001 }, 'maxEntries'],
        [{ cleanupIntervalMs: 0 }, 'cleanupIntervalMs'],
        [{ requestLimit: 10, userRequestLimit: 9 }, 'userRequestLimit'],
        [{ windowMs: 1_000, cleanupIntervalMs: 1_001 }, 'cleanupIntervalMs'],
    ] as const)('rejects an invalid injected policy %p', (policy, field) => {
        expect(() => new AnimationRumV2ReadThrottleService(policy)).toThrow(TypeError)
        expect(() => new AnimationRumV2ReadThrottleService(policy)).toThrow(field)
    })

    it.each([null, 1, 'policy', [], new Date(), { extraField: 60 }, { [Symbol('requestLimit')]: 60 }])(
        'rejects a malformed or open injected policy: %p',
        policy => {
            expect(() => new AnimationRumV2ReadThrottleService(policy as never)).toThrow(TypeError)
        }
    )

    it('states that enforcement is process-local best-effort rather than cluster-wide', () => {
        expect(ANIMATION_RUM_V2_READ_THROTTLE_ENFORCEMENT).toBe('process-local-best-effort')
    })
})
