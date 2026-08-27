import { INestApplication, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PassportModule, PassportStrategy } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { ExtractJwt, Strategy } from 'passport-jwt'
import * as request from 'supertest'

import { createMonitorValidationPipe } from '../common/validation/monitor-validation.pipe'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV2QueryController } from './animation-rum-v2-query.controller'
import { AnimationRumV2QueryService } from './animation-rum-v2-query.service'
import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'
import { AnimationRumV2ReadThrottleService } from './animation-rum-v2-read-throttle.service'

const JWT_SECRET = 'animation-rum-v2-query-http-fixture-secret'

@Injectable()
class FixtureJwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: JWT_SECRET,
        })
    }

    validate(payload: { sub: number }) {
        return { id: payload.sub }
    }
}

describe('Animation RUM v2 query HTTP boundary', () => {
    let app: INestApplication
    const queries = {
        summary: jest.fn(),
        captures: jest.fn(),
        capture: jest.fn(),
    }
    const throttle = {
        consume: jest.fn(),
    }

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
            controllers: [AnimationRumV2QueryController],
            providers: [
                AnimationRumV2JwtGuard,
                AnimationRumV2ReadThrottleGuard,
                FixtureJwtStrategy,
                { provide: AnimationRumV2ReadThrottleService, useValue: throttle },
                { provide: AnimationRumV2QueryService, useValue: queries },
            ],
        }).compile()
        app = module.createNestApplication()
        app.useGlobalPipes(createMonitorValidationPipe())
        app.setGlobalPrefix('api')
        await app.init()
    })

    beforeEach(() => {
        queries.summary.mockReset().mockResolvedValue({ captures: { observed: 0 } })
        queries.captures.mockReset().mockResolvedValue({ captures: [] })
        queries.capture.mockReset().mockResolvedValue({ capture: { captureId: 'capture_12345678' } })
        throttle.consume.mockReset().mockReturnValue({ allowed: true, remaining: 59, retryAfterSeconds: 0 })
    })

    afterAll(async () => {
        await app.close()
    })

    const auth = () => `Bearer ${new JwtService({ secret: JWT_SECRET }).sign({ sub: 41 })}`

    it('rejects unauthenticated reads and marks them non-cacheable', async () => {
        await request(app.getHttpServer())
            .get('/api/animation/rum-v2/summary?appId=vanillaFixture1')
            .expect(401)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
        expect(queries.summary).not.toHaveBeenCalled()
        expect(throttle.consume).not.toHaveBeenCalled()
    })

    it.each([
        '/api/animation/rum-v2/summary?appId=vanillaFixture1&unexpected=value',
        '/api/animation/rum-v2/summary?appId=vanillaFixture1&from=2026-08-26',
        '/api/animation/rum-v2/captures?appId=vanillaFixture1&limit=101',
        `/api/animation/rum-v2/captures/${encodeURIComponent('../events')}?appId=vanillaFixture1`,
    ])('rejects invalid query input before the service: %s', async endpoint => {
        await request(app.getHttpServer())
            .get(endpoint)
            .set('Authorization', auth())
            .expect(400)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
        expect(queries.summary).not.toHaveBeenCalled()
        expect(queries.captures).not.toHaveBeenCalled()
        expect(queries.capture).not.toHaveBeenCalled()
    })

    it('uses the JWT actor and typed pagination for a valid request', async () => {
        await request(app.getHttpServer())
            .get('/api/animation/rum-v2/captures?appId=vanillaFixture1&scope=target&limit=20&offset=40')
            .set('Authorization', auth())
            .expect(200)
            .expect('RateLimit-Remaining', '59')
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
            .expect({ success: true, data: { captures: [] } })

        expect(queries.captures).toHaveBeenCalledWith(
            41,
            expect.objectContaining({ appId: 'vanillaFixture1', scope: 'target', limit: 20, offset: 40 })
        )
    })

    it('keeps capture identity and application ownership context separate', async () => {
        await request(app.getHttpServer())
            .get('/api/animation/rum-v2/captures/capture_12345678?appId=vanillaFixture1')
            .set('Authorization', auth())
            .expect(200)
            .expect('Cache-Control', 'private, no-store')

        expect(queries.capture).toHaveBeenCalledWith(41, 'vanillaFixture1', 'capture_12345678')
    })

    it.each([
        ['/api/animation/rum-v2/summary?appId=vanillaFixture1', 'vanillaFixture1'],
        ['/api/animation/rum-v2/captures?appId=unknownFixture1', 'unknownFixture1'],
        ['/api/animation/rum-v2/captures/capture_12345678?appId=unknownFixture1', 'unknownFixture1'],
    ])('rate-limits every read route without revealing app ownership: %s', async (endpoint, appId) => {
        throttle.consume.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 17 })

        await request(app.getHttpServer())
            .get(endpoint)
            .set('Authorization', auth())
            .expect(429)
            .expect('Retry-After', '17')
            .expect('RateLimit-Remaining', '0')
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
            .expect({ statusCode: 429, message: 'Animation RUM v2 read rate limit exceeded' })

        expect(throttle.consume).toHaveBeenCalledWith(41, appId)
        expect(queries.summary).not.toHaveBeenCalled()
        expect(queries.captures).not.toHaveBeenCalled()
        expect(queries.capture).not.toHaveBeenCalled()
    })
})
