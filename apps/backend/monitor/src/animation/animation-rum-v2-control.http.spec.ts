import { ForbiddenException, INestApplication, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { PassportStrategy } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { ExtractJwt, Strategy } from 'passport-jwt'
import * as request from 'supertest'

import { createMonitorValidationPipe } from '../common/validation/monitor-validation.pipe'
import { AnimationRumV2ControlController } from './animation-rum-v2-control.controller'
import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'

const JWT_SECRET = 'animation-rum-v2-http-fixture-secret'

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

describe('Animation RUM v2 control HTTP boundary', () => {
    let app: INestApplication
    const control = {
        configurePolicy: jest.fn(),
    }

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
            controllers: [AnimationRumV2ControlController],
            providers: [AnimationRumV2JwtGuard, FixtureJwtStrategy, { provide: AnimationRumV2ControlService, useValue: control }],
        }).compile()
        app = module.createNestApplication()
        app.useGlobalPipes(createMonitorValidationPipe())
        app.setGlobalPrefix('api')
        await app.init()
    })

    beforeEach(() => {
        control.configurePolicy.mockReset().mockResolvedValue({ enabled: false })
    })

    afterAll(async () => {
        await app.close()
    })

    const endpoint = '/api/animation/rum-v2/policy'
    const validBody = { appId: 'vanillaFixture1', maxRoutes: 2, maxTargets: 4, maxDeployments: 2 }
    const auth = () => `Bearer ${new JwtService({ secret: JWT_SECRET }).sign({ sub: 41 })}`

    it('returns a non-cacheable 401 without a JWT', async () => {
        await request(app.getHttpServer())
            .post(endpoint)
            .send(validBody)
            .expect(401)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
        expect(control.configurePolicy).not.toHaveBeenCalled()
    })

    it.each([
        { body: { ...validBody, maxRoutes: '2' }, caseName: 'an implicitly convertible quota' },
        { body: { ...validBody, unexpected: true }, caseName: 'a non-whitelisted field' },
    ])('returns a non-cacheable 400 for $caseName', async ({ body }) => {
        await request(app.getHttpServer())
            .post(endpoint)
            .set('Authorization', auth())
            .send(body)
            .expect(400)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
        expect(control.configurePolicy).not.toHaveBeenCalled()
    })

    it('uses the JWT actor for a valid non-cacheable request', async () => {
        await request(app.getHttpServer())
            .post(endpoint)
            .set('Authorization', auth())
            .send(validBody)
            .expect(201)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
            .expect({ success: true, data: { enabled: false } })

        expect(control.configurePolicy).toHaveBeenCalledWith(41, expect.objectContaining(validBody))
    })

    it('keeps ownership failures non-cacheable', async () => {
        control.configurePolicy.mockRejectedValueOnce(new ForbiddenException('Application not found'))

        await request(app.getHttpServer())
            .post(endpoint)
            .set('Authorization', auth())
            .send(validBody)
            .expect(403)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
    })
})
