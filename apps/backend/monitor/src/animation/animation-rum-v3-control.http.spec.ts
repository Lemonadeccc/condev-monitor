import { ForbiddenException, INestApplication, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PassportModule, PassportStrategy } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { ExtractJwt, Strategy } from 'passport-jwt'
import * as request from 'supertest'

import { createMonitorValidationPipe } from '../common/validation/monitor-validation.pipe'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV3SoftNavigationControlController } from './animation-rum-v3-control.controller'
import { AnimationRumV3SoftNavigationControlService } from './animation-rum-v3-control.service'

const JWT_SECRET = 'animation-rum-v3-control-http-fixture-secret'

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

describe('Animation RUM v3 soft-navigation control HTTP boundary', () => {
    let app: INestApplication
    const control = { state: jest.fn(), configure: jest.fn(), disable: jest.fn() }

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
            controllers: [AnimationRumV3SoftNavigationControlController],
            providers: [
                AnimationRumV2JwtGuard,
                FixtureJwtStrategy,
                { provide: AnimationRumV3SoftNavigationControlService, useValue: control },
            ],
        }).compile()
        app = module.createNestApplication()
        app.useGlobalPipes(createMonitorValidationPipe())
        app.setGlobalPrefix('api')
        await app.init()
    })

    beforeEach(() => {
        control.state.mockReset().mockResolvedValue({ appId: 'vanillaFixture1', policy: null, routes: [], deployments: [] })
        control.configure.mockReset().mockResolvedValue({ appId: 'vanillaFixture1', policy: { enabled: true } })
        control.disable.mockReset().mockResolvedValue({ appId: 'vanillaFixture1', policy: { enabled: false } })
    })

    afterAll(async () => {
        await app.close()
    })

    const auth = () => `Bearer ${new JwtService({ secret: JWT_SECRET }).sign({ sub: 41 })}`
    const validBody = {
        appId: 'vanillaFixture1',
        routeKey: 'catalog.detail',
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
    }

    it.each([
        ['get', '/api/animation/rum-v3/soft-navigation/control/state?appId=vanillaFixture1'],
        ['post', '/api/animation/rum-v3/soft-navigation/control/configure'],
    ] as const)('rejects unauthenticated %s requests without reaching the service', async (method, endpoint) => {
        const call = request(app.getHttpServer())[method](endpoint)
        if (method === 'post') call.send(validBody)
        await call.expect(401).expect('Cache-Control', 'private, no-store').expect('Pragma', 'no-cache')
        expect(control.state).not.toHaveBeenCalled()
        expect(control.configure).not.toHaveBeenCalled()
    })

    it.each([
        { ...validBody, routeKey: '/raw/path' },
        { ...validBody, environment: 'private value' },
        { ...validBody, enabled: true },
        { ...validBody, unexpected: true },
    ])('rejects an invalid or non-whitelisted configure body before the service', async body => {
        await request(app.getHttpServer())
            .post('/api/animation/rum-v3/soft-navigation/control/configure')
            .set('Authorization', auth())
            .send(body)
            .expect(400)
            .expect('Cache-Control', 'private, no-store')
        expect(control.configure).not.toHaveBeenCalled()
    })

    it('uses the JWT actor and typed configure body', async () => {
        await request(app.getHttpServer())
            .post('/api/animation/rum-v3/soft-navigation/control/configure')
            .set('Authorization', auth())
            .send(validBody)
            .expect(201)
            .expect('Cache-Control', 'private, no-store')
            .expect({ success: true, data: { appId: 'vanillaFixture1', policy: { enabled: true } } })
        expect(control.configure).toHaveBeenCalledWith(41, expect.objectContaining(validBody))
    })

    it('keeps ownership failures opaque and non-cacheable', async () => {
        control.state.mockRejectedValueOnce(new ForbiddenException('Application not found'))
        await request(app.getHttpServer())
            .get('/api/animation/rum-v3/soft-navigation/control/state?appId=unknownFixture1')
            .set('Authorization', auth())
            .expect(403)
            .expect('Cache-Control', 'private, no-store')
            .expect('Pragma', 'no-cache')
    })

    it('disables only the authenticated application policy', async () => {
        await request(app.getHttpServer())
            .post('/api/animation/rum-v3/soft-navigation/control/disable')
            .set('Authorization', auth())
            .send({ appId: 'vanillaFixture1' })
            .expect(201)
            .expect('Cache-Control', 'private, no-store')
        expect(control.disable).toHaveBeenCalledWith(41, 'vanillaFixture1')
    })
})
